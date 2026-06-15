/** @format */

const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const {
	normalizeComparable,
	normalizeWhitespace,
	redactSensitive,
	safeSnippet,
	expandHotelNameCandidates,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	normalizeConfirmation,
} = require("./otaReservationMapper");

const DEFAULT_LOGIN_URL =
	"https://expediapartnercentral.com/Account/Logon?returnUrl=https%3A%2F%2Fapps.expediapartnercentral.com%2Fmanageproperty%2FManageProperty";
const DEFAULT_MANAGE_PROPERTY_URL =
	"https://apps.expediapartnercentral.com/manageproperty/ManageProperty";
const DEFAULT_BOOKINGS_URL =
	"https://apps.expediapartnercentral.com/lodging/bookings";
const DEFAULT_RESERVATION_DETAIL_URL =
	"https://apps.expediapartnercentral.com/lodging/reservations/legacyReservationDetails.html";
const DEFAULT_OUTPUT_DIR = path.join(
	process.cwd(),
	"audits",
	"expedia-reservation-sync"
);
const DEFAULT_PROFILE_DIR = path.join(
	os.homedir(),
	".jannatbooking",
	"expedia-reservation-sync-profile"
);
const MAX_RUN_MS = Number(process.env.OTA_EXPEDIA_SYNC_MAX_RUN_MS || 55_000);
const MAX_RESERVATION_CANDIDATES_PER_HOTEL = Number(
	process.env.OTA_EXPEDIA_SYNC_MAX_CANDIDATES_PER_HOTEL || 80
);
const MAX_DETAIL_PAGES_PER_HOTEL = Number(
	process.env.OTA_EXPEDIA_SYNC_MAX_DETAIL_PAGES_PER_HOTEL || 30
);
const NAVIGATION_TIMEOUT_MS = Number(
	process.env.OTA_EXPEDIA_SYNC_NAVIGATION_TIMEOUT_MS || 15_000
);
const MFA_SESSION_TIMEOUT_MS = Number(
	process.env.OTA_EXPEDIA_MFA_TIMEOUT_MS || 10 * 60 * 1000
);
const activeCollectors = new Map();
const activeMfaSessions = new Map();

const EMAIL_INPUT_SELECTORS = [
	"input[type='email']",
	"input[name*='email' i]",
	"input[id*='email' i]",
	"input[autocomplete='username']",
	"input[type='text']",
];
const PASSWORD_INPUT_SELECTORS = [
	"input[type='password']",
	"input[name*='password' i]",
	"input[id*='password' i]",
	"input[autocomplete='current-password']",
];
const MFA_INPUT_SELECTORS = [
	"input[autocomplete='one-time-code']",
	"input[name*='code' i]",
	"input[id*='code' i]",
	"input[name*='otp' i]",
	"input[id*='otp' i]",
	"input[type='tel']",
	"input[type='text']",
];

const normalizeLine = (value) => String(value || "").replace(/\s+/g, " ").trim();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const expediaAppBaseUrl = () =>
	String(process.env.OTA_EXPEDIA_APP_BASE_URL || "https://apps.expediapartnercentral.com")
		.replace(/\/+$/, "");

const buildExpediaBookingsUrl = (propertyId = "") => {
	const url = new URL(
		process.env.OTA_EXPEDIA_BOOKINGS_URL || DEFAULT_BOOKINGS_URL,
		expediaAppBaseUrl()
	);
	if (propertyId) url.searchParams.set("htid", String(propertyId));
	return url.toString();
};

const buildExpediaReservationDetailUrl = (propertyId = "", reservationId = "") => {
	const url = new URL(
		process.env.OTA_EXPEDIA_RESERVATION_DETAIL_URL ||
			DEFAULT_RESERVATION_DETAIL_URL,
		expediaAppBaseUrl()
	);
	if (propertyId) url.searchParams.set("htid", String(propertyId));
	if (reservationId) url.searchParams.set("reservationIds", String(reservationId));
	return url.toString();
};

const toUsDateInput = (value = "") => {
	const raw = normalizeLine(value);
	if (!raw) return "";
	const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (iso) return `${iso[2]}/${iso[3]}/${iso[1]}`;
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) return raw;
	return `${String(parsed.getMonth() + 1).padStart(2, "0")}/${String(
		parsed.getDate()
	).padStart(2, "0")}/${parsed.getFullYear()}`;
};

const ensureDirectory = (dir) => {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

const collectorOutputDir = () =>
	ensureDirectory(process.env.OTA_EXPEDIA_SYNC_OUTPUT_DIR || DEFAULT_OUTPUT_DIR);

const collectorProfileDir = () =>
	ensureDirectory(
		process.env.OTA_EXPEDIA_BROWSER_PROFILE_DIR || DEFAULT_PROFILE_DIR
	);

const isLikelyPropertyName = (value) => {
	const line = normalizeLine(value);
	if (!line || line.length < 3) return false;
	return !/^(home|search|your properties|property id|terms of use)$/i.test(line);
};

const parsePropertiesFromText = (rawText) => {
	const allLines = String(rawText || "")
		.split(/\r?\n/)
		.map(normalizeLine)
		.filter(Boolean);
	const markerIndex = allLines.findIndex((line) =>
		/^your properties$/i.test(line)
	);
	const lines = markerIndex >= 0 ? allLines.slice(markerIndex + 1) : allLines;
	const properties = [];
	const seen = new Set();

	for (let index = 0; index < lines.length - 1; index += 1) {
		const name = lines[index];
		const idMatch = lines[index + 1].match(/^Property ID\s+([A-Za-z0-9-]+)/i);
		if (!idMatch || !isLikelyPropertyName(name)) continue;

		const expediaPropertyId = idMatch[1];
		const key = `${expediaPropertyId}:${name.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		properties.push({ name, expediaPropertyId, url: "" });
	}

	return properties;
};

const hasPropertyListText = (value) =>
	/Your Properties|Property ID|Manage a property/i.test(value || "");

const isLoginOrVerificationPage = ({ url = "", text = "" } = {}) =>
	/\/Account\/Logon|signin|login/i.test(url) ||
	(/(sign in|email|password|verification|captcha|multi-factor|mfa)/i.test(text) &&
		!/Your Properties|Property ID/i.test(text));

const isMfaChallengePage = ({ text = "" } = {}) =>
	/(verification code|security code|one[-\s]?time|authentication code|login code|enter\s+(?:the\s+)?code|two[-\s]?step|two[-\s]?factor|multi[-\s]?factor|mfa|authenticator|resend code)/i.test(
		text || ""
	);

const isCaptchaOrRobotChallenge = ({ text = "" } = {}) =>
	/(captcha|robot|automated access|unusual traffic|verify you are human)/i.test(
		text || ""
	);

const safePageSnapshot = async (page) => {
	try {
		return page.evaluate(() => ({
			text: document.body.innerText || "",
			title: document.title || "",
			url: window.location.href || "",
		}));
	} catch (error) {
		return {
			text: "",
			title: "",
			url: page.url(),
			error: error && error.message ? error.message : String(error),
		};
	}
};

const isElementVisible = (element) =>
	element.evaluate((node) => {
		const style = window.getComputedStyle(node);
		const rect = node.getBoundingClientRect();
		return (
			style &&
			style.visibility !== "hidden" &&
			style.display !== "none" &&
			rect.width > 0 &&
			rect.height > 0 &&
			!node.disabled &&
			node.getAttribute("aria-disabled") !== "true"
		);
	});

const typeIntoFirstVisibleInput = async (page, selectors, value) => {
	for (const selector of selectors) {
		const elements = await page.$$(selector).catch(() => []);
		for (const element of elements) {
			if (!(await isElementVisible(element).catch(() => false))) continue;
			await element.click({ clickCount: 3 }).catch(() => {});
			await page.keyboard.press("Backspace").catch(() => {});
			await element.type(String(value || ""), { delay: 20 });
			return true;
		}
	}
	return false;
};

const clickButtonByText = async (page, patterns = []) =>
	page.evaluate((rawPatterns) => {
		const regexes = rawPatterns.map((pattern) => new RegExp(pattern, "i"));
		const nodes = Array.from(
			document.querySelectorAll(
				"button, input[type='button'], input[type='submit'], a, [role='button']"
			)
		);
		const visible = (node) => {
			const style = window.getComputedStyle(node);
			const rect = node.getBoundingClientRect();
			return (
				style &&
				style.visibility !== "hidden" &&
				style.display !== "none" &&
				rect.width > 0 &&
				rect.height > 0 &&
				!node.disabled &&
				node.getAttribute("aria-disabled") !== "true"
			);
		};
		const candidate = nodes.find((node) => {
			if (!visible(node)) return false;
			const text = [
				node.innerText,
				node.textContent,
				node.value,
				node.getAttribute("aria-label"),
			]
				.filter(Boolean)
				.join(" ");
			return regexes.some((regex) => regex.test(text));
		});
		if (!candidate) return false;
		candidate.click();
		return true;
	}, patterns);

const clickOrPressEnter = async (page, patterns = []) => {
	const clicked = await clickButtonByText(page, patterns).catch(() => false);
	if (!clicked) await page.keyboard.press("Enter").catch(() => {});
	await Promise.race([
		page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => null),
		delay(2500),
	]);
	await delay(900);
};

const clickPropertyByName = async (page, propertyName = "") =>
	page.evaluate((name) => {
		const normalize = (value) =>
			String(value || "")
				.toLowerCase()
				.replace(/&/g, "and")
				.replace(/[^a-z0-9]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		const target = normalize(name);
		if (!target) return false;
		const candidates = Array.from(
			document.querySelectorAll(
				"a, button, [role='button'], [tabindex], li, article, section, div"
			)
		);
		const visible = (node) => {
			const style = window.getComputedStyle(node);
			const rect = node.getBoundingClientRect();
			return (
				style &&
				style.visibility !== "hidden" &&
				style.display !== "none" &&
				rect.width > 0 &&
				rect.height > 0
			);
		};
		const direct = candidates.find((node) => {
			if (!visible(node)) return false;
			const text = normalize(node.innerText || node.textContent || "");
			return text === target;
		});
		const containing = direct || candidates.find((node) => {
			if (!visible(node)) return false;
			const text = normalize(node.innerText || node.textContent || "");
			return text.includes(target) && text.length <= target.length + 120;
		});
		if (!containing) return false;
		const clickable = containing.closest("a, button, [role='button'], [tabindex]") || containing;
		clickable.click();
		return true;
	}, propertyName);

const openPropertyPage = async (page, property = {}) => {
	if (property.href || property.url) {
		await page.goto(property.href || property.url, { waitUntil: "domcontentloaded" });
		await delay(700);
		return true;
	}
	const clicked = await clickPropertyByName(page, property.name).catch(() => false);
	if (!clicked) return false;
	await Promise.race([
		page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null),
		delay(2500),
	]);
	await delay(900);
	return true;
};

const expediaCredentials = () => ({
	username: normalizeLine(process.env.OTA_EXPEDIA_USERNAME || ""),
	password: String(process.env.OTA_PASSWORD || ""),
});

const waitForMfaCode = ({ jobId, attempt }) =>
	new Promise((resolve, reject) => {
		const key = String(jobId);
		const expiresAt = new Date(Date.now() + MFA_SESSION_TIMEOUT_MS);
		const timer = setTimeout(() => {
			activeMfaSessions.delete(key);
			reject(new Error("mfa_timeout"));
		}, MFA_SESSION_TIMEOUT_MS);
		activeMfaSessions.set(key, {
			attempt,
			expiresAt,
			resolve: (code) => {
				clearTimeout(timer);
				activeMfaSessions.delete(key);
				resolve(code);
			},
			reject: (error) => {
				clearTimeout(timer);
				activeMfaSessions.delete(key);
				reject(error);
			},
		});
	});

const clearMfaSession = (jobId) => {
	const key = String(jobId || "");
	const session = activeMfaSessions.get(key);
	if (session?.reject) session.reject(new Error("mfa_session_closed"));
	activeMfaSessions.delete(key);
};

const findPageByContent = async (browser, matcher, timeoutMs) => {
	const deadline = Date.now() + timeoutMs;
	let lastSeen = [];

	while (Date.now() < deadline) {
		const pages = await browser.pages();
		lastSeen = [];
		for (const candidate of pages) {
			const snapshot = await safePageSnapshot(candidate);
			lastSeen.push({
				title: snapshot.title,
				url: snapshot.url || candidate.url(),
				hasBodyText: Boolean(snapshot.text),
			});
			if (matcher(snapshot, candidate)) return candidate;
		}
		await delay(750);
	}

	const detail = lastSeen
		.map((page) => `${page.title || "Untitled"} <${page.url}>`)
		.join("; ");
	throw new Error(`Timed out waiting for Expedia page. Last tabs: ${detail}`);
};

const scrollToLoadVisibleContent = async (page) => {
	await page.evaluate(async () => {
		await new Promise((resolve) => {
			let stableRounds = 0;
			let previousHeight = 0;
			const interval = setInterval(() => {
				window.scrollBy(0, 700);
				const currentHeight = document.body.scrollHeight;
				if (currentHeight === previousHeight) {
					stableRounds += 1;
				} else {
					stableRounds = 0;
					previousHeight = currentHeight;
				}
				if (stableRounds >= 4) {
					clearInterval(interval);
					window.scrollTo(0, 0);
					resolve();
				}
			}, 180);
		});
	});
};

const extractProperties = async (page) => {
	const snapshot = await page.evaluate(() => {
		const links = Array.from(document.querySelectorAll("a"))
			.map((link) => ({
				text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
				href: link.href || "",
			}))
			.filter((link) => link.text && link.href);
		return { text: document.body.innerText || "", links };
	});

	const parsed = parsePropertiesFromText(snapshot.text);
	return parsed.map((property) => {
		const propertyKey = normalizeComparable(property.name);
		const match = snapshot.links.find((link) => {
			const linkKey = normalizeComparable(link.text);
			return linkKey === propertyKey || linkKey.includes(propertyKey);
		});
		return { ...property, url: match ? match.href : "" };
	});
};

const scorePropertyForHotel = (property = {}, hotel = {}) => {
	const propertyKey = normalizeComparable(property.name);
	if (!propertyKey) return 0;
	const keys = Array.from(
		new Set([
			...(hotel.matchKeys || []),
			...(hotel.aliases || []).map((alias) => normalizeComparable(alias.name)),
			...expandHotelNameCandidates([
				hotel.hotelName,
				hotel.hotelNameOtherLanguage,
			]).map(normalizeComparable),
			normalizeComparable(hotel.hotelName),
			normalizeComparable(hotel.hotelNameOtherLanguage),
		].filter(Boolean))
	);
	let best = 0;
	for (const key of keys) {
		if (!key) continue;
		if (propertyKey === key) best = Math.max(best, 100);
		else if (propertyKey.includes(key) || key.includes(propertyKey)) {
			best = Math.max(best, 92);
		} else {
			const propertyTokens = new Set(propertyKey.split(" ").filter(Boolean));
			const keyTokens = new Set(key.split(" ").filter(Boolean));
			const intersection = [...keyTokens].filter((token) =>
				propertyTokens.has(token)
			).length;
			const score = Math.round(
				(intersection / Math.max(keyTokens.size, propertyTokens.size, 1)) * 100
			);
			best = Math.max(best, score);
		}
	}
	return best;
};

const matchPropertiesToHotels = (properties = [], hotels = []) =>
	hotels.map((hotel) => {
		const ranked = properties
			.map((property) => ({
				property,
				score: scorePropertyForHotel(property, hotel),
			}))
			.sort((left, right) => right.score - left.score);
		const best = ranked[0];
		return {
			hotel,
			property: best && best.score >= 72 ? best.property : null,
			bestProperty: best ? best.property : null,
			matchScore: best ? best.score : 0,
		};
	});

const findReservationsLink = async (page) => {
	const links = await page.evaluate(() =>
		Array.from(document.querySelectorAll("a"))
			.map((link) => ({
				text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
				href: link.href || "",
			}))
			.filter((link) => link.href)
	);
	const candidates = links
		.map((link) => ({
			...link,
			score:
				/reservations?/i.test(link.text) || /reservations?/i.test(link.href)
					? 100
					: /bookings?/i.test(link.text) || /bookings?/i.test(link.href)
					? 80
					: /guests?/i.test(link.text)
					? 55
					: 0,
		}))
		.filter((link) => link.score > 0 && !/help|review|message|support/i.test(link.href));
	candidates.sort((left, right) => right.score - left.score);
	return candidates[0] || null;
};

const clickReservationsNavigation = async (page) =>
	page.evaluate(() => {
		const normalize = (value) =>
			String(value || "")
				.replace(/\s+/g, " ")
				.trim();
		const visible = (node) => {
			const style = window.getComputedStyle(node);
			const rect = node.getBoundingClientRect();
			return (
				style &&
				style.visibility !== "hidden" &&
				style.display !== "none" &&
				rect.width > 0 &&
				rect.height > 0 &&
				node.getAttribute("aria-disabled") !== "true" &&
				!node.disabled
			);
		};
		const nodeText = (node) =>
			[
				node.innerText,
				node.textContent,
				node.getAttribute("aria-label"),
				node.getAttribute("title"),
			]
				.filter(Boolean)
				.map(normalize)
				.join(" ");
		const nodes = Array.from(
			document.querySelectorAll(
				"nav *, aside *, a, button, [role='button'], [role='link'], [tabindex]"
			)
		);
		const exact = nodes.find((node) => {
			if (!visible(node)) return false;
			return /^reservations?$/i.test(nodeText(node));
		});
		const loose = exact || nodes.find((node) => {
			if (!visible(node)) return false;
			const text = nodeText(node);
			return (
				/reservations?/i.test(text) &&
				text.length <= 80 &&
				!/help|support|review/i.test(text)
			);
		});
		if (!loose) return false;
		const clickable =
			loose.closest("a, button, [role='button'], [role='link'], [tabindex]") ||
			loose;
		clickable.click();
		return true;
	});

const waitForReservationsSurface = async (page) => {
	await Promise.race([
		page
			.waitForNavigation({
				waitUntil: "domcontentloaded",
				timeout: 8000,
			})
			.catch(() => null),
		page
			.waitForFunction(
				() =>
					/reservations?/i.test(window.location.href || "") ||
					/(reservation\s*(?:id|number|#)|confirmation|guest\s+name|check[-\s]?in|check[-\s]?out|arrival|departure|booked|booking\s+date)/i.test(
						document.body.innerText || ""
					),
				{ timeout: 8000 }
			)
			.catch(() => null),
		delay(3500),
	]);
	await delay(900);
};

const applyBookingsDateFilter = async (page, { dateFrom = "", dateTo = "" } = {}) => {
	const from = toUsDateInput(dateFrom);
	const to = toUsDateInput(dateTo);
	if (!from || !to) {
		return { applied: false, reason: "missing_range" };
	}

	const fieldResult = await page
		.evaluate(({ fromValue, toValue }) => {
			const visible = (node) => {
				const style = window.getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				return (
					style &&
					style.visibility !== "hidden" &&
					style.display !== "none" &&
					rect.width > 0 &&
					rect.height > 0 &&
					!node.disabled &&
					node.getAttribute("aria-disabled") !== "true"
				);
			};
			const descriptor =
				Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value") ||
				{};
			const setValue = (input, value) => {
				if (!input || !value) return false;
				if (descriptor.set) descriptor.set.call(input, value);
				else input.value = value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
				input.dispatchEvent(new Event("blur", { bubbles: true }));
				return true;
			};
			const inputs = Array.from(document.querySelectorAll("input")).filter(
				(input) => {
					if (!visible(input)) return false;
					const hint = [
						input.placeholder,
						input.name,
						input.id,
						input.getAttribute("aria-label"),
						input.getAttribute("data-testid"),
						input.closest("label")?.innerText,
						input.parentElement?.innerText,
					]
						.filter(Boolean)
						.join(" ");
					return /mm\/dd\/yyyy|date|from|to|check/i.test(hint);
				}
			);
			return {
				inputCount: inputs.length,
				fromSet: setValue(inputs[0], fromValue),
				toSet: setValue(inputs[1], toValue),
			};
		}, { fromValue: from, toValue: to })
		.catch((error) => ({
			inputCount: 0,
			fromSet: false,
			toSet: false,
			error: error && error.message ? error.message : String(error),
		}));

	const clickedApply =
		fieldResult.fromSet && fieldResult.toSet
			? await clickButtonByText(page, ["^apply$"]).catch(() => false)
			: false;
	if (clickedApply) {
		await waitForReservationsSurface(page);
	}
	return {
		applied: Boolean(fieldResult.fromSet && fieldResult.toSet && clickedApply),
		from,
		to,
		...fieldResult,
		clickedApply,
	};
};

const openReservationsPage = async (
	page,
	property = {},
	{ dateFrom = "", dateTo = "" } = {}
) => {
	if (property.expediaPropertyId) {
		const directUrl = buildExpediaBookingsUrl(property.expediaPropertyId);
		await page.goto(directUrl, { waitUntil: "domcontentloaded" });
		await waitForReservationsSurface(page);
		const snapshot = await safePageSnapshot(page);
		if (/reservations?|bookings?/i.test(`${snapshot.title} ${snapshot.text}`)) {
			const dateFilter = await applyBookingsDateFilter(page, {
				dateFrom,
				dateTo,
			});
			return {
				opened: true,
				method: "direct_bookings_url",
				href: directUrl,
				dateFilter,
			};
		}
	}

	const reservationLink = await findReservationsLink(page).catch(() => null);
	if (reservationLink?.href) {
		await page.goto(reservationLink.href, { waitUntil: "domcontentloaded" });
		await delay(900);
		const dateFilter = await applyBookingsDateFilter(page, {
			dateFrom,
			dateTo,
		});
		return {
			opened: true,
			method: "href",
			href: reservationLink.href,
			text: reservationLink.text || "",
			dateFilter,
		};
	}

	const clicked = await clickReservationsNavigation(page).catch(() => false);
	if (!clicked) {
		return {
			opened: false,
			method: "not_found",
		};
	}
	await waitForReservationsSurface(page);
	const dateFilter = await applyBookingsDateFilter(page, {
		dateFrom,
		dateTo,
	});
	return {
		opened: true,
		method: "click",
		dateFilter,
	};
};

const confirmationCandidatesFromText = (text = "") => {
	const source = normalizeWhitespace(text);
	const values = [];
	const patterns = [
		/(?:reservation|booking|itinerary|confirmation)\s*(?:id|number|#|no\.?)?\s*[:#-]?\s*([A-Z0-9-]{6,24})/gi,
		/\b([0-9]{8,16})\b/g,
	];
	for (const pattern of patterns) {
		let match;
		while ((match = pattern.exec(source))) {
			const value = String(match[1] || "")
				.replace(/[^A-Z0-9-]/gi, "")
				.trim();
			if (value && !values.includes(value)) values.push(value);
		}
	}
	return values.filter((value) => !/^20\d{2}$/.test(value)).slice(0, 5);
};

const monthIndex = (value = "") => {
	const key = String(value || "").slice(0, 3).toLowerCase();
	return {
		jan: 0,
		feb: 1,
		mar: 2,
		apr: 3,
		may: 4,
		jun: 5,
		jul: 6,
		aug: 7,
		sep: 8,
		oct: 9,
		nov: 10,
		dec: 11,
	}[key];
};

const toIsoDate = (year, month, day) => {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	if (!yyyy || !mm || !dd) return "";
	return `${String(yyyy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(
		dd
	).padStart(2, "0")}`;
};

const parseExpediaDate = (value = "") => {
	const raw = normalizeLine(value);
	if (!raw) return "";
	const monthMatch = raw.match(
		/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i
	);
	if (monthMatch) {
		const month = monthIndex(monthMatch[1]);
		if (month >= 0) return toIsoDate(monthMatch[3], month + 1, monthMatch[2]);
	}
	const slashMatch = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
	if (slashMatch) {
		const year =
			slashMatch[3].length === 2 ? `20${slashMatch[3]}` : slashMatch[3];
		return toIsoDate(year, slashMatch[1], slashMatch[2]);
	}
	const isoMatch = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
	return isoMatch ? `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}` : "";
};

const extractExpediaDates = (value = "") => {
	const source = String(value || "");
	const matches = [
		...(source.match(
			/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/gi
		) || []),
		...(source.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g) || []),
		...(source.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []),
	];
	return matches
		.map((text) => ({ text: normalizeLine(text), iso: parseExpediaDate(text) }))
		.filter((date) => date.iso);
};

const parseMoneyValue = (value = "", fallbackCurrency = "") => {
	const raw = normalizeLine(value);
	if (!raw) return null;
	const currencyFirst = raw.match(
		/\b([A-Z]{3})\s*([+-]?\d[\d,]*(?:\.\d{1,2})?)\b/
	);
	const amountFirst = raw.match(
		/\b([+-]?\d[\d,]*(?:\.\d{1,2})?)\s*([A-Z]{3})\b/
	);
	const amountOnly = raw.match(/(^|[^\d])([+-]?\d[\d,]*(?:\.\d{1,2}))/);
	const currency = currencyFirst?.[1] || amountFirst?.[2] || fallbackCurrency || "";
	const amountText = currencyFirst?.[2] || amountFirst?.[1] || amountOnly?.[2] || "";
	const amount = Number(String(amountText).replace(/,/g, ""));
	if (!Number.isFinite(amount)) return null;
	return {
		currency,
		amount,
		raw,
	};
};

const parseExpediaStatusToApply = (value = "") => {
	const text = normalizeLine(value).toLowerCase();
	if (/cancelled|canceled/.test(text)) return "cancelled";
	if (/no[-\s]?show/.test(text)) return "no_show";
	if (/booked|confirmed|recent/.test(text)) return "confirmed";
	return "";
};

const detectExpediaPaymentCollectionModel = (value = "") => {
	const text = normalizeWhitespace(value).toLowerCase();
	if (/expedia\s+(collects|collect)/.test(text)) return "expedia_collect";
	if (/hotel\s+(collects|collect)|property\s+(collects|collect)/.test(text)) {
		return "hotel_collect";
	}
	return "unknown";
};

const hasSensitivePaymentSignal = (value = "") =>
	/(virtual\s+card|card\s+number|cvv|cvc|security\s+code|payment\s+details|expedia\s+collects?\s+payment|expedia\s+collect)/i.test(
		value || ""
	);

const extractRows = async (page) =>
	page.evaluate(() => {
		const selectors = [
			"tr",
			"[role='row']",
			"[data-testid*='reservation' i]",
			"[class*='reservation' i]",
			"[class*='booking' i]",
		];
		const nodes = Array.from(document.querySelectorAll(selectors.join(",")));
		const seen = new Set();
		return nodes
			.map((node) => {
				const rawText = node.innerText || node.textContent || "";
				const text = rawText.replace(/\s+/g, " ").trim();
				const lines = rawText
					.split(/\r?\n/)
					.map((line) => line.replace(/\s+/g, " ").trim())
					.filter(Boolean);
				const cells = Array.from(
					node.querySelectorAll("td, th, [role='cell'], [role='gridcell']")
				)
					.map((cell) =>
						(cell.innerText || cell.textContent || "")
							.replace(/\s+/g, " ")
							.trim()
					)
					.filter(Boolean);
				const link = node.querySelector("a[href]");
				const href = link ? link.href : "";
				return { text, lines, cells, href };
			})
			.filter((row) => {
				if (!row.text || row.text.length < 12) return false;
				if (row.text.length > 1600) return false;
				if (/^(guest|reservation|confirmation|check[-\s]?in|check[-\s]?out|room|booked on|booking amount)\b/i.test(row.text)) {
					return false;
				}
				if (seen.has(row.text)) return false;
				seen.add(row.text);
				return true;
			})
			.slice(0, 250);
	});

const parseLightReservationDetails = (text = "") => {
	const snippet = normalizeWhitespace(redactSensitive(text));
	const dates = Array.from(
		new Set(
			(snippet.match(
				/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/gi
			) || []).slice(0, 4)
		)
	);
	const amountMatch = snippet.match(
		/\b(?:SAR|USD|US\$|\$|ريال|ر\.س)\s*[0-9,]+(?:\.[0-9]{1,2})?|\b[0-9,]+(?:\.[0-9]{1,2})?\s*(?:SAR|USD|US\$|\$|ريال|ر\.س)\b/i
	);
	const guestMatch = snippet.match(
		/(?:guest|traveler|customer)\s*(?:name)?\s*[:#-]?\s*([A-Z][A-Za-z .'-]{2,80})/i
	);
	return {
		guestName: guestMatch ? normalizeWhitespace(guestMatch[1]) : "",
		dateHints: dates,
		amountHint: amountMatch ? normalizeWhitespace(amountMatch[0]) : "",
	};
};

const detectCurrency = (value = "") => {
	const match = String(value || "").match(
		/\b(USD|SAR|AED|EUR|GBP|KWD|QAR|BHD|OMR|EGP)\b/i
	);
	return match ? match[1].toUpperCase() : "";
};

const lineValueAfter = (lines = [], pattern, maxLookahead = 4) => {
	const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
	for (let index = 0; index < lines.length; index += 1) {
		const line = normalizeLine(lines[index]);
		if (!regex.test(line)) continue;
		for (
			let valueIndex = index + 1;
			valueIndex < Math.min(lines.length, index + 1 + maxLookahead);
			valueIndex += 1
		) {
			const value = normalizeLine(lines[valueIndex]);
			if (!value || regex.test(value) || /^edit$/i.test(value)) continue;
			return value;
		}
	}
	return "";
};

const moneyAfterLine = (lines = [], pattern, fallbackCurrency = "", maxLookahead = 5) => {
	const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
	for (let index = 0; index < lines.length; index += 1) {
		if (!regex.test(normalizeLine(lines[index]))) continue;
		for (
			let valueIndex = index + 1;
			valueIndex < Math.min(lines.length, index + 1 + maxLookahead);
			valueIndex += 1
		) {
			const money = parseMoneyValue(lines[valueIndex], fallbackCurrency);
			if (money) return money;
		}
	}
	return null;
};

const parseGuestCount = (value = "") => {
	const text = normalizeWhitespace(value).toLowerCase();
	const adultsMatch = text.match(/(\d+)\s*adult/);
	const childrenMatch = text.match(/(\d+)\s*(?:child|children)/);
	const guestsMatch = text.match(/(\d+)\s*(?:guest|people|person|persons)/);
	const adults = adultsMatch ? Number(adultsMatch[1]) : 0;
	const children = childrenMatch ? Number(childrenMatch[1]) : 0;
	const totalGuests = guestsMatch
		? Number(guestsMatch[1])
		: adults || children
		? adults + children
		: 0;
	return { adults, children, totalGuests };
};

const parseExpediaReservationDetailText = (rawText = "", candidate = {}) => {
	const safeText = normalizeWhitespace(redactSensitive(rawText));
	const lines = String(rawText || "")
		.split(/\r?\n/)
		.map(normalizeLine)
		.filter(Boolean);
	const fallbackCurrency =
		candidate.currency || detectCurrency(rawText) || detectCurrency(candidate.amountHint);
	const reservationId =
		normalizeConfirmation(
			String(rawText || "").match(/Reservation\s*#\s*([A-Z0-9-]+)/i)?.[1] ||
				candidate.reservationId ||
				candidate.confirmationNumber
		) || "";
	const hotelConfirmationRaw = lineValueAfter(
		lines,
		/^Hotel confirmation code$/i,
		3
	);
	const hotelConfirmationNumber =
		normalizeConfirmation(confirmationCandidatesFromText(hotelConfirmationRaw)[0]) ||
		candidate.hotelConfirmationNumber ||
		"";
	const itineraryNumber = normalizeConfirmation(
		lineValueAfter(lines, /^Itinerary number$/i, 2)
	);
	const paymentRequestId = lineValueAfter(lines, /^Payment request ID$/i, 2);
	const statusRaw = lineValueAfter(lines, /^Status$/i, 2);
	const reservationMadeRaw = lineValueAfter(lines, /^Reservation made$/i, 2);
	const pricingModel = lineValueAfter(lines, /^Pricing model$/i, 2);
	const beddingRequest = lineValueAfter(lines, /^Bedding request$/i, 3);
	const ratePlanCode = lineValueAfter(lines, /^Rate plan code$/i, 2);
	const ratePlanName = lineValueAfter(lines, /^Rate plan name$/i, 2);
	const arrivalTime = lineValueAfter(lines, /^Estimated arrival time$/i, 3);
	const roomName =
		lineValueAfter(lines, /^Room Type$/i, 3) || candidate.roomName || "";
	const guestCount = parseGuestCount(lineValueAfter(lines, /^Guest count$/i, 3));

	const dateRangeMatch = String(rawText || "").match(
		/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\s*(?:[\u2013\u2014-]|to)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})(?:\s*\((\d+)\s*nights?\))?/i
	);
	const allDates = extractExpediaDates(rawText);
	const checkinDate =
		parseExpediaDate(dateRangeMatch?.[1]) || candidate.checkinDate || allDates[0]?.iso || "";
	const checkoutDate =
		parseExpediaDate(dateRangeMatch?.[2]) || candidate.checkoutDate || allDates[1]?.iso || "";
	const nights = Number(dateRangeMatch?.[3] || 0) || candidate.nights || 0;
	const bookedAt =
		parseExpediaDate(reservationMadeRaw) ||
		candidate.bookedAt ||
		(allDates.length > 2 ? allDates[2].iso : "");

	const nightlyRate = moneyAfterLine(lines, /^Nightly rates?/i, fallbackCurrency);
	const taxes = moneyAfterLine(lines, /^Taxes$/i, fallbackCurrency);
	const totalGuestPayment = moneyAfterLine(
		lines,
		/^Total guest payment$/i,
		fallbackCurrency
	);
	const expediaCompensation = moneyAfterLine(
		lines,
		/^Expedia Group'?s compensation$/i,
		fallbackCurrency
	);
	const accelerator = moneyAfterLine(lines, /^Accelerator/i, fallbackCurrency);
	const totalPayout = moneyAfterLine(lines, /^Your total payout$/i, fallbackCurrency, 6);
	const amount = totalGuestPayment || parseMoneyValue(candidate.amountHint, fallbackCurrency);
	const detectedPaymentCollectionModel =
		detectExpediaPaymentCollectionModel(rawText);
	const paymentCollectionModel =
		detectedPaymentCollectionModel !== "unknown"
			? detectedPaymentCollectionModel
			: candidate.paymentCollectionModel || "unknown";

	return {
		detailsFetched: true,
		reservationId,
		confirmationNumber: reservationId || candidate.confirmationNumber,
		hotelConfirmationNumber,
		alternateConfirmationNumbers: [
			hotelConfirmationNumber,
			candidate.hotelConfirmationNumber,
			itineraryNumber,
		].filter(Boolean),
		itineraryNumber,
		paymentRequestId,
		statusRaw,
		statusToApply: parseExpediaStatusToApply(statusRaw || candidate.statusRaw),
		bookedAt,
		checkinDate,
		checkoutDate,
		nights,
		roomName,
		arrivalTime,
		pricingModel,
		beddingRequest,
		ratePlanCode,
		ratePlanName,
		adults: guestCount.adults || candidate.adults || 0,
		children: guestCount.children || candidate.children || 0,
		totalGuests: guestCount.totalGuests || candidate.totalGuests || 0,
		currency: amount?.currency || fallbackCurrency || candidate.currency || "",
		amount: amount?.amount || candidate.amount || 0,
		amountHint: amount?.raw || candidate.amountHint || "",
		paymentCollectionModel,
		paymentSummary: {
			nightlyRateAmount: nightlyRate?.amount || 0,
			taxesAmount: taxes?.amount || 0,
			totalGuestPaymentAmount: totalGuestPayment?.amount || 0,
			expediaCompensationAmount: expediaCompensation?.amount || 0,
			acceleratorAmount: accelerator?.amount || 0,
			totalPayoutAmount: totalPayout?.amount || 0,
			currency: totalPayout?.currency || amount?.currency || fallbackCurrency || "",
		},
		paymentSignals: {
			hasPaymentDetails: hasSensitivePaymentSignal(rawText),
			hasVirtualCardSignal: /virtual\s+card|card\s+number|cvv|cvc/i.test(
				rawText || ""
			),
			rawCardStored: false,
		},
		sourceSnippet: safeSnippet(safeText, 900),
	};
};

const isLikelyGuestName = (value = "") => {
	const text = normalizeLine(value);
	if (!text || text.length > 90 || /\d/.test(text)) return false;
	if (
		/(recent|reservation|confirmation|check[-\s]?in|check[-\s]?out|booked|booking|amount|room|view|expedia|collect|usd|sar|date|status|payment)/i.test(
			text
		)
	) {
		return false;
	}
	return /[A-Za-z]/.test(text);
};

const parseReservationRowCandidate = (row, hotel, property) => {
	const text = normalizeWhitespace(row.text || "");
	if (!text || !/\b\d{8,16}\b/.test(text)) return null;
	const ids = Array.from(
		new Set(confirmationCandidatesFromText(text).map(normalizeConfirmation))
	).filter((value) => value && /^\d{8,16}$/.test(value));
	const hrefReservationId = normalizeConfirmation(
		String(row.href || "").match(/[?&]reservationIds=([A-Z0-9-]+)/i)?.[1] || ""
	);
	const reservationId = hrefReservationId || ids[0] || "";
	if (!reservationId) return null;
	const hotelConfirmationNumber =
		ids.find((value) => value !== reservationId) || "";
	const cells = Array.isArray(row.cells) ? row.cells.map(normalizeLine).filter(Boolean) : [];
	const lines = Array.isArray(row.lines) ? row.lines.map(normalizeLine).filter(Boolean) : [];
	const reservationCellIndex = cells.findIndex((cell) =>
		cell.includes(reservationId)
	);
	const guestName =
		(reservationCellIndex > 0
			? cells.slice(0, reservationCellIndex).reverse().find(isLikelyGuestName)
			: "") ||
		lines.slice(0, 4).find(isLikelyGuestName) ||
		"";
	const dates = extractExpediaDates(text);
	const amountCell = cells.find((cell) => parseMoneyValue(cell));
	const amount = parseMoneyValue(amountCell || text);
	const roomName =
		cells.find(
			(cell) =>
				/(room|suite|studio|apartment|bed|view)/i.test(cell) &&
				!/(booking amount|room$|rooms and rates)/i.test(cell)
		) || "";
	const detailUrl =
		row.href && /reservation|booking|legacy/i.test(row.href)
			? row.href
			: buildExpediaReservationDetailUrl(
					property.expediaPropertyId,
					reservationId
			  );
	const details = parseLightReservationDetails(text);
	const statusRaw = /recent/i.test(text) ? "Recent" : "";

	return {
		provider: "expedia",
		hotelId: hotel.hotelId,
		hotelName: hotel.hotelName,
		expediaPropertyId: property.expediaPropertyId || "",
		expediaPropertyName: property.name || "",
		confirmationNumber: reservationId,
		reservationId,
		hotelConfirmationNumber,
		alternateConfirmationNumbers: [hotelConfirmationNumber].filter(Boolean),
		guestName: guestName || details.guestName || "",
		checkinDate: dates[0]?.iso || "",
		checkoutDate: dates[1]?.iso || "",
		bookedAt: dates[2]?.iso || "",
		roomName,
		statusRaw,
		statusToApply: parseExpediaStatusToApply(statusRaw),
		currency: amount?.currency || detectCurrency(text),
		amount: amount?.amount || 0,
		amountHint: amount?.raw || details.amountHint || "",
		paymentCollectionModel: detectExpediaPaymentCollectionModel(text),
		detailUrl,
		sourceUrl: detailUrl || row.href || "",
		sourceSnippet: safeSnippet(text, 700),
	};
};

const enrichCandidateFromDetailPage = async (page, candidate) => {
	if (!candidate.detailUrl) return candidate;
	await page.goto(candidate.detailUrl, { waitUntil: "domcontentloaded" });
	await delay(900);
	await scrollToLoadVisibleContent(page).catch(() => {});
	const snapshot = await safePageSnapshot(page);
	const detail = parseExpediaReservationDetailText(snapshot.text, candidate);
	return {
		...candidate,
		...Object.fromEntries(
			Object.entries(detail).filter(([, value]) => {
				if (Array.isArray(value)) return value.length > 0;
				if (value && typeof value === "object") return true;
				return value !== undefined && value !== null && value !== "";
			})
		),
		sourceUrl: snapshot.url || candidate.detailUrl,
		detailUrl: candidate.detailUrl,
	};
};

const extractReservationCandidates = async (page, hotel, property) => {
	const rows = await extractRows(page);
	const candidates = [];
	const seen = new Set();

	for (const row of rows) {
		const candidate = parseReservationRowCandidate(row, hotel, property);
		if (!candidate) continue;
		const key = `${hotel.hotelId}:${candidate.reservationId || candidate.confirmationNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push(candidate);
		if (candidates.length >= MAX_RESERVATION_CANDIDATES_PER_HOTEL) {
			break;
		}
	}

	const enriched = [];
	for (let index = 0; index < candidates.length; index += 1) {
		const candidate = candidates[index];
		if (index >= MAX_DETAIL_PAGES_PER_HOTEL) {
			enriched.push({
				...candidate,
				detailsFetched: false,
				detailsSkippedReason: "detail_page_cap_reached",
			});
			continue;
		}
		try {
			enriched.push(await enrichCandidateFromDetailPage(page, candidate));
		} catch (error) {
			enriched.push({
				...candidate,
				detailsFetched: false,
				detailsError: error && error.message ? error.message : String(error),
			});
		}
	}

	return enriched;
};

const emptyBuckets = () => ({
	newReservations: [],
	matchedExisting: [],
	statusChanged: [],
	conflicts: [],
	needsReview: [],
	paymentOrVccAvailable: [],
});

const summarizeBuckets = (buckets = emptyBuckets()) => ({
	newReservations: buckets.newReservations.length,
	matchedExisting: buckets.matchedExisting.length,
	statusChanged: buckets.statusChanged.length,
	conflicts: buckets.conflicts.length,
	needsReview: buckets.needsReview.length,
	paymentOrVccAvailable: buckets.paymentOrVccAvailable.length,
	appliedWrites: 0,
});

const appendAudit = async (jobId, entry = {}) =>
	OtaReservationSyncJob.updateOne(
		{ _id: jobId },
		{
			$push: {
				auditLog: {
					at: new Date(),
					...entry,
				},
			},
		}
	);

const updateJob = (jobId, update) =>
	OtaReservationSyncJob.findByIdAndUpdate(jobId, update, { new: true }).lean().exec();

const normalizeHotelId = (value) =>
	String(value?._id || value?.hotelId || value || "").trim();

const resolveSelectedTargets = (job, selectedHotelIds = []) => {
	const targets = Array.isArray(job?.targetHotels) ? job.targetHotels : [];
	const availableIds = new Set(targets.map((hotel) => normalizeHotelId(hotel.hotelId)));
	const selected = Array.from(
		new Set((Array.isArray(selectedHotelIds) ? selectedHotelIds : [])
			.map(normalizeHotelId)
			.filter(Boolean))
	);

	if (!selected.length) {
		return {
			ok: false,
			statusCode: 400,
			error: "Select at least one OTA-mapped hotel before running the collector.",
		};
	}

	const invalid = selected.filter((hotelId) => !availableIds.has(hotelId));
	if (invalid.length) {
		return {
			ok: false,
			statusCode: 400,
			error: "One or more selected hotels are not part of this OTA sync job.",
		};
	}

	const selectedSet = new Set(selected);
	return {
		ok: true,
		selectedHotelIds: selected,
		targetHotels: targets.filter((hotel) => selectedSet.has(normalizeHotelId(hotel.hotelId))),
	};
};

const classifyCandidate = async (candidate) => {
	const lookupValues = Array.from(
		new Set(
			[
				candidate.confirmationNumber,
				candidate.reservationId,
				candidate.hotelConfirmationNumber,
				candidate.itineraryNumber,
				...(Array.isArray(candidate.alternateConfirmationNumbers)
					? candidate.alternateConfirmationNumbers
					: []),
			]
				.map(normalizeConfirmation)
				.filter(Boolean)
		)
	);
	let existing = null;
	let matchedLookupValue = "";
	for (const lookupValue of lookupValues) {
		existing = await findReservationByOtaConfirmation(
			lookupValue,
			"_id hotelId confirmation_number reservation_id customer_details supplierData reservation_status state"
		);
		if (existing) {
			matchedLookupValue = lookupValue;
			break;
		}
	}
	if (!existing) {
		return {
			bucket: "newReservations",
			item: {
				...candidate,
				actionPreview: "candidate_new_reservation_needs_detail_review",
			},
		};
	}
	const currentStatus = normalizeLine(
		existing.reservation_status || existing.state || ""
	).toLowerCase();
	const statusToApply = normalizeLine(candidate.statusToApply || "").toLowerCase();
	const isMeaningfulStatusChange =
		statusToApply &&
		["cancelled", "no_show"].includes(statusToApply) &&
		statusToApply !== currentStatus;
	return {
		bucket: isMeaningfulStatusChange ? "statusChanged" : "matchedExisting",
		item: {
			...candidate,
			actionPreview: isMeaningfulStatusChange
				? "matched_existing_status_change_no_write"
				: "matched_existing_no_write",
			reservationId: String(existing._id),
			pmsConfirmationNumber: existing.confirmation_number || "",
			currentStatus: existing.reservation_status || existing.state || "",
			incomingStatus: candidate.statusRaw || candidate.statusToApply || "",
			matchedLookupValue,
			matchedReservationBy: detectConfirmationMatchFields(
				existing,
				matchedLookupValue || candidate.confirmationNumber
			),
		},
	};
};

const launchBrowser = async () => {
	const headlessEnv = String(process.env.OTA_EXPEDIA_HEADLESS || "true").toLowerCase();
	const headless = ["0", "false", "no"].includes(headlessEnv)
		? false
		: ["new", "shell"].includes(headlessEnv)
		  ? headlessEnv
		  : "new";
	const isHeadless = headless !== false;
	const launchArgs = ["--window-size=1440,950"];
	const noSandbox =
		process.platform === "linux" ||
		/^(1|true|yes)$/i.test(process.env.EXPEDIA_BROWSER_NO_SANDBOX || "");
	if (noSandbox) launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");

	const options = {
		headless,
		userDataDir: collectorProfileDir(),
		defaultViewport: isHeadless ? { width: 1440, height: 950 } : null,
		args: launchArgs,
	};
	if (process.env.EXPEDIA_BROWSER_PATH) {
		options.executablePath = process.env.EXPEDIA_BROWSER_PATH;
	}
	return puppeteer.launch(options);
};

const updateLoginBlockedJob = async ({
	jobId,
	job,
	status,
	message,
	buckets,
	artifacts,
	prefix,
	page,
}) => {
	const screenshotPath = path.join(
		artifacts.outputDir,
		`${prefix}-${job.jobNumber}.png`
	);
	await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
	artifacts.screenshots.push(screenshotPath);
	await updateJob(jobId, {
		$set: {
			status,
			previewBuckets: buckets,
			collectorArtifacts: artifacts,
			collectorState: {
				status,
				finishedAt: new Date(),
				readOnly: true,
				message,
			},
			resultSummary: summarizeBuckets(buckets),
		},
	});
};

const handleMfaChallenge = async ({
	jobId,
	job,
	page,
	buckets,
	artifacts,
	actorId,
}) => {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const screenshotPath = path.join(
			artifacts.outputDir,
			`needs-mfa-${job.jobNumber}-attempt-${attempt}.png`
		);
		await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
		artifacts.screenshots.push(screenshotPath);
		const expiresAt = new Date(Date.now() + MFA_SESSION_TIMEOUT_MS);
		await updateJob(jobId, {
			$set: {
				status: "needs_mfa",
				previewBuckets: buckets,
				collectorArtifacts: artifacts,
				collectorState: {
					status: "needs_mfa",
					readOnly: true,
					attempt,
					expiresAt,
					message:
						attempt === 1
							? "Expedia accepted the password step and is requesting a verification code."
							: "Expedia still requires verification. Enter the newest code.",
				},
				resultSummary: summarizeBuckets(buckets),
			},
		});
		await appendAudit(jobId, {
			action: "collector_needs_mfa",
			by: actorId,
			readOnly: true,
			attempt,
		});

		let code = "";
		try {
			code = await waitForMfaCode({ jobId, attempt });
		} catch (error) {
			return {
				ok: false,
				status: "needs_mfa",
				message:
					error?.message === "mfa_timeout"
						? "Expedia MFA timed out. Run the collector again when you have the code ready."
						: "Expedia MFA session was closed. Run the collector again.",
			};
		}

		await updateJob(jobId, {
			$set: {
				status: "running",
				"collectorState.status": "submitting_mfa",
				"collectorState.lastProgressAt": new Date(),
				"collectorState.message": "Submitting Expedia verification code.",
			},
		});

		const typed = await typeIntoFirstVisibleInput(
			page,
			MFA_INPUT_SELECTORS,
			code
		);
		if (!typed) {
			continue;
		}
		await clickOrPressEnter(page, ["verify", "continue", "submit", "next", "sign in"]);
		let snapshot = await safePageSnapshot(page);
		if (hasPropertyListText(snapshot.text)) {
			return { ok: true, page };
		}
		if (!isMfaChallengePage(snapshot) && !isLoginOrVerificationPage(snapshot)) {
			await page
				.goto(process.env.OTA_EXPEDIA_MANAGE_PROPERTY_URL || DEFAULT_MANAGE_PROPERTY_URL, {
					waitUntil: "domcontentloaded",
				})
				.catch(() => {});
			await delay(1200);
			snapshot = await safePageSnapshot(page);
			if (hasPropertyListText(snapshot.text)) {
				return { ok: true, page };
			}
		}
	}
	return {
		ok: false,
		status: "needs_mfa",
		message:
			"Expedia did not accept the submitted verification code after three attempts.",
	};
};

const attemptExpediaLogin = async ({
	jobId,
	job,
	page,
	buckets,
	artifacts,
	actorId,
}) => {
	const credentials = expediaCredentials();
	if (!credentials.username || !credentials.password) {
		return {
			ok: false,
			status: "needs_credentials",
			message: "Configure OTA_EXPEDIA_USERNAME and OTA_PASSWORD on the server.",
		};
	}

	await updateJob(jobId, {
		$set: {
			"collectorState.status": "submitting_login",
			"collectorState.lastProgressAt": new Date(),
			"collectorState.message": "Submitting Expedia credentials from server env.",
		},
	});
	await appendAudit(jobId, {
		action: "collector_submitting_login",
		by: actorId,
		readOnly: true,
		usernameEnvKey: "OTA_EXPEDIA_USERNAME",
		passwordEnvKey: "OTA_PASSWORD",
	});

	if (await typeIntoFirstVisibleInput(page, EMAIL_INPUT_SELECTORS, credentials.username)) {
		await clickOrPressEnter(page, ["next", "continue", "sign in"]);
	}

	let snapshot = await safePageSnapshot(page);
	if (hasPropertyListText(snapshot.text)) return { ok: true, page };
	if (isCaptchaOrRobotChallenge(snapshot)) {
		return {
			ok: false,
			status: "needs_manual_verification",
			message:
				"Expedia displayed a human verification challenge. The collector will not bypass CAPTCHA or bot checks.",
		};
	}
	if (isMfaChallengePage(snapshot)) {
		return handleMfaChallenge({ jobId, job, page, buckets, artifacts, actorId });
	}

	if (await typeIntoFirstVisibleInput(page, PASSWORD_INPUT_SELECTORS, credentials.password)) {
		await clickOrPressEnter(page, ["sign in", "continue", "next", "log in", "login"]);
	}

	snapshot = await safePageSnapshot(page);
	if (hasPropertyListText(snapshot.text)) return { ok: true, page };
	if (isCaptchaOrRobotChallenge(snapshot)) {
		return {
			ok: false,
			status: "needs_manual_verification",
			message:
				"Expedia displayed a human verification challenge. The collector will not bypass CAPTCHA or bot checks.",
		};
	}
	if (isMfaChallengePage(snapshot)) {
		return handleMfaChallenge({ jobId, job, page, buckets, artifacts, actorId });
	}

	await page
		.goto(process.env.OTA_EXPEDIA_MANAGE_PROPERTY_URL || DEFAULT_MANAGE_PROPERTY_URL, {
			waitUntil: "domcontentloaded",
		})
		.catch(() => {});
	await delay(1200);
	snapshot = await safePageSnapshot(page);
	if (hasPropertyListText(snapshot.text)) return { ok: true, page };

	return {
		ok: false,
		status: "needs_login",
		message:
			"Expedia login could not be completed with the stored credentials. Manual sign-in may be required.",
	};
};

const runCollector = async ({ jobId, actorId, selectedHotelIds = [] }) => {
	const startedAt = Date.now();
	let browser = null;
	const buckets = emptyBuckets();
	const artifacts = {
		outputDir: collectorOutputDir(),
		screenshots: [],
		propertyCount: 0,
		matchedPropertyCount: 0,
		selectedHotelCount: selectedHotelIds.length,
	};

	try {
		const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
		if (!job) return;
		if (job.credentialSummary?.missing?.length) {
			await updateJob(jobId, {
				$set: {
					status: "needs_credentials",
					"collectorState.finishedAt": new Date(),
					"collectorState.error": "missing_credentials",
				},
			});
			return;
		}

		await updateJob(jobId, {
			$set: {
				status: "running",
				collectorState: {
					status: "running",
					startedAt: new Date(),
					currentHotelIndex: 0,
					currentHotelName: "",
					mode: "single_browser_sequential",
					readOnly: true,
					selectedHotelIds,
					selectedHotelCount: selectedHotelIds.length,
				},
				previewBuckets: buckets,
				collectorArtifacts: artifacts,
			},
		});
		await appendAudit(jobId, {
			action: "collector_started",
			by: actorId,
			readOnly: true,
			mode: "single_browser_sequential",
		});

		browser = await launchBrowser();
		let page = await browser.newPage();
		page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
		page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
		const managePropertyUrl =
			process.env.OTA_EXPEDIA_MANAGE_PROPERTY_URL ||
			DEFAULT_MANAGE_PROPERTY_URL;
		await page.goto(managePropertyUrl, { waitUntil: "domcontentloaded" });
		await delay(1500);

		let snapshot = await safePageSnapshot(page);
		if (isLoginOrVerificationPage(snapshot)) {
			const loginResult = await attemptExpediaLogin({
				jobId,
				job,
				page,
				buckets,
				artifacts,
				actorId,
			});
			if (!loginResult.ok) {
				await updateLoginBlockedJob({
					jobId,
					job,
					status: loginResult.status || "needs_login",
					message:
						loginResult.message ||
						"Expedia session is not logged in or requires verification.",
					buckets,
					artifacts,
					prefix: loginResult.status || "needs-login",
					page,
				});
				await appendAudit(jobId, {
					action: loginResult.status || "collector_needs_login",
					by: actorId,
					readOnly: true,
				});
				return;
			}
			page = loginResult.page || page;
			snapshot = await safePageSnapshot(page);
		}

		if (!hasPropertyListText(snapshot.text)) {
			await page.goto(process.env.OTA_EXPEDIA_LOGIN_URL || DEFAULT_LOGIN_URL, {
				waitUntil: "domcontentloaded",
			});
			const propertyPage = await findPageByContent(
				browser,
				(pageSnapshot) => hasPropertyListText(pageSnapshot.text),
				Math.min(20_000, MAX_RUN_MS)
			);
			await propertyPage.bringToFront();
			page = propertyPage;
		}

		await scrollToLoadVisibleContent(page);
		let properties = await extractProperties(page);
		if (!properties.length) {
			const propertyPage = await findPageByContent(
				browser,
				(pageSnapshot) => hasPropertyListText(pageSnapshot.text),
				10_000
			);
			await propertyPage.bringToFront();
			await scrollToLoadVisibleContent(propertyPage);
			page = propertyPage;
			properties = await extractProperties(propertyPage);
		}
		artifacts.propertyCount = properties.length;
		artifacts.properties = properties.map((property) => ({
			name: property.name || "",
			expediaPropertyId: property.expediaPropertyId || "",
		}));

		const selectedSet = new Set(selectedHotelIds.map(normalizeHotelId));
		const targetHotels = (job.targetHotels || []).filter((hotel) =>
			selectedSet.has(normalizeHotelId(hotel.hotelId))
		);
		const matches = matchPropertiesToHotels(properties, targetHotels);
		artifacts.matchedPropertyCount = matches.filter((match) => match.property).length;

		for (let index = 0; index < matches.length; index += 1) {
			if (Date.now() - startedAt > MAX_RUN_MS - 5000) {
				buckets.needsReview.push({
					actionPreview: "time_budget_reached",
					message:
						"Collector stopped before all hotels to stay inside the configured run budget.",
					remainingHotels: matches.length - index,
				});
				break;
			}

			const match = matches[index];
			const hotel = match.hotel;
			await updateJob(jobId, {
				$set: {
					"collectorState.currentHotelIndex": index + 1,
					"collectorState.currentHotelName": hotel.hotelName,
					"collectorState.selectedHotelCount": matches.length,
					"collectorState.lastProgressAt": new Date(),
					previewBuckets: buckets,
					collectorArtifacts: artifacts,
					resultSummary: summarizeBuckets(buckets),
				},
			});

			if (!match.property) {
				buckets.needsReview.push({
					hotelId: hotel.hotelId,
					hotelName: hotel.hotelName,
					actionPreview: "property_not_matched",
					matchScore: match.matchScore,
					bestExpediaPropertyName: match.bestProperty?.name || "",
					bestExpediaPropertyId: match.bestProperty?.expediaPropertyId || "",
				});
				continue;
			}

			let reservationNavigation = await openReservationsPage(page, match.property, {
				dateFrom: job.dateFrom,
				dateTo: job.dateTo,
			}).catch((error) => ({
				opened: false,
				method: "direct_error",
				error: error && error.message ? error.message : String(error),
			}));
			if (!reservationNavigation.opened) {
				const propertyOpened = await openPropertyPage(page, match.property).catch(
					() => false
				);
				if (propertyOpened) {
					reservationNavigation = await openReservationsPage(page, match.property, {
						dateFrom: job.dateFrom,
						dateTo: job.dateTo,
					}).catch((error) => ({
						opened: false,
						method: "fallback_error",
						error: error && error.message ? error.message : String(error),
					}));
				}
			}
			if (!reservationNavigation.opened) {
				buckets.needsReview.push({
					hotelId: hotel.hotelId,
					hotelName: hotel.hotelName,
					actionPreview: "property_matched_but_reservations_not_opened",
					matchScore: match.matchScore,
					expediaPropertyName: match.property?.name || "",
					expediaPropertyId: match.property?.expediaPropertyId || "",
					reservationNavigation,
				});
				continue;
			}
			await scrollToLoadVisibleContent(page).catch(() => {});
			const candidates = await extractReservationCandidates(
				page,
				hotel,
				match.property
			);
			if (!candidates.length) {
				const pageSnapshot = await safePageSnapshot(page);
				buckets.needsReview.push({
					hotelId: hotel.hotelId,
					hotelName: hotel.hotelName,
					expediaPropertyId: match.property.expediaPropertyId || "",
					expediaPropertyName: match.property.name || "",
					actionPreview: "no_reservation_candidates_detected",
					reservationNavigation,
					sourceUrl: page.url(),
					sourceSnippet: safeSnippet(pageSnapshot.text, 500),
				});
			}
			for (const candidate of candidates) {
				const hasPaymentSignal =
					candidate.paymentSignals?.hasPaymentDetails ||
					candidate.paymentSignals?.hasVirtualCardSignal ||
					(candidate.paymentCollectionModel &&
						candidate.paymentCollectionModel !== "unknown") ||
					Number(candidate.paymentSummary?.totalPayoutAmount || 0) > 0 ||
					Number(candidate.paymentSummary?.totalGuestPaymentAmount || 0) > 0;
				if (hasPaymentSignal) {
					buckets.paymentOrVccAvailable.push({
						hotelId: candidate.hotelId,
						hotelName: candidate.hotelName,
						expediaPropertyId: candidate.expediaPropertyId,
						expediaPropertyName: candidate.expediaPropertyName,
						confirmationNumber: candidate.confirmationNumber,
						reservationId: candidate.reservationId,
						hotelConfirmationNumber: candidate.hotelConfirmationNumber,
						paymentCollectionModel: candidate.paymentCollectionModel || "unknown",
						currency: candidate.currency || candidate.paymentSummary?.currency || "",
						totalGuestPaymentAmount:
							candidate.paymentSummary?.totalGuestPaymentAmount ||
							candidate.amount ||
							0,
						totalPayoutAmount: candidate.paymentSummary?.totalPayoutAmount || 0,
						hasVirtualCardSignal:
							candidate.paymentSignals?.hasVirtualCardSignal || false,
						rawCardStored: false,
						actionPreview: "payment_signal_no_card_data_stored",
					});
				}
				const classification = await classifyCandidate(candidate);
				buckets[classification.bucket].push(classification.item);
			}

			await updateJob(jobId, {
				$set: {
					previewBuckets: buckets,
					collectorArtifacts: artifacts,
					resultSummary: summarizeBuckets(buckets),
				},
			});

			await page.goto(managePropertyUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
			await delay(450);
		}

		const finalStatus = "preview_ready";
		await updateJob(jobId, {
			$set: {
				status: finalStatus,
				previewBuckets: buckets,
				collectorArtifacts: artifacts,
				resultSummary: summarizeBuckets(buckets),
				collectorState: {
					status: finalStatus,
					startedAt: new Date(startedAt),
					finishedAt: new Date(),
					durationMs: Date.now() - startedAt,
					mode: "single_browser_sequential",
					readOnly: true,
					selectedHotelIds,
					selectedHotelCount: matches.length,
				},
			},
		});
		await appendAudit(jobId, {
			action: "collector_finished",
			by: actorId,
			readOnly: true,
			summary: summarizeBuckets(buckets),
		});
	} catch (error) {
		await updateJob(jobId, {
			$set: {
				status: "collector_failed",
				previewBuckets: buckets,
				collectorArtifacts: artifacts,
				resultSummary: summarizeBuckets(buckets),
				collectorState: {
					status: "collector_failed",
					finishedAt: new Date(),
					durationMs: Date.now() - startedAt,
					readOnly: true,
					error: error?.message || String(error),
				},
			},
		}).catch(() => {});
		await appendAudit(jobId, {
			action: "collector_failed",
			by: actorId,
			readOnly: true,
			error: error?.message || String(error),
		}).catch(() => {});
	} finally {
		clearMfaSession(jobId);
		activeCollectors.delete(String(jobId));
		if (browser && !/^(1|true|yes)$/i.test(process.env.OTA_EXPEDIA_KEEP_BROWSER_OPEN || "")) {
			await browser.close().catch(() => {});
		}
	}
};

const startExpediaReservationCollectorJob = async ({
	jobId,
	actor,
	selectedHotelIds = [],
}) => {
	const key = String(jobId || "");
	if (activeCollectors.has(key)) {
		const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
		return { ok: true, statusCode: 202, job, alreadyRunning: true };
	}
	if (activeCollectors.size > 0) {
		return {
			ok: false,
			statusCode: 409,
			error: "Another OTA reservation collector is already running.",
		};
	}
	const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
	if (!job) {
		return { ok: false, statusCode: 404, error: "OTA reservation sync job not found." };
	}
	if (job.provider !== "expedia") {
		return {
			ok: false,
			statusCode: 400,
			error: "The browser collector currently supports Expedia only.",
		};
	}
	if (job.credentialSummary?.missing?.length) {
		return {
			ok: false,
			statusCode: 409,
			error: `Missing server env: ${job.credentialSummary.missing.join(", ")}`,
		};
	}
	const selection = resolveSelectedTargets(job, selectedHotelIds);
	if (!selection.ok) {
		return selection;
	}

	activeCollectors.set(key, true);
	setImmediate(() =>
		runCollector({
			jobId,
			actorId: actor?._id || actor?.id || "",
			selectedHotelIds: selection.selectedHotelIds,
		})
	);
	const updated = await updateJob(jobId, {
		$set: {
			status: "queued",
			collectorState: {
				status: "queued",
				queuedAt: new Date(),
				mode: "single_browser_sequential",
				readOnly: true,
				selectedHotelIds: selection.selectedHotelIds,
				selectedHotelCount: selection.targetHotels.length,
			},
			"collectorArtifacts.selectedHotelCount": selection.targetHotels.length,
		},
		$push: {
			auditLog: {
				at: new Date(),
				action: "collector_queued",
				by: actor?._id || actor?.id || "",
				readOnly: true,
				selectedHotelIds: selection.selectedHotelIds,
				selectedHotelCount: selection.targetHotels.length,
			},
		},
	});
	return { ok: true, statusCode: 202, job: updated };
};

const submitExpediaReservationMfaCode = async ({ jobId, actor, code }) => {
	const key = String(jobId || "");
	const normalizedCode = normalizeLine(code).replace(/\s+/g, "");
	if (!normalizedCode || !/^[0-9A-Za-z-]{3,16}$/.test(normalizedCode)) {
		return {
			ok: false,
			statusCode: 400,
			error: "Enter a valid Expedia verification code.",
		};
	}
	const session = activeMfaSessions.get(key);
	if (!session) {
		const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
		return {
			ok: false,
			statusCode: 409,
			job,
			error:
				"No active Expedia MFA session is waiting for a code. Run the collector again if needed.",
		};
	}
	await appendAudit(jobId, {
		action: "collector_mfa_code_submitted",
		by: actor?._id || actor?.id || "",
		readOnly: true,
		attempt: session.attempt,
		codeReceived: true,
		codeStored: false,
	});
	await updateJob(jobId, {
		$set: {
			status: "running",
			"collectorState.status": "mfa_code_received",
			"collectorState.lastProgressAt": new Date(),
			"collectorState.message": "Expedia verification code received.",
		},
	});
	session.resolve(normalizedCode);
	const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
	return { ok: true, statusCode: 202, job };
};

module.exports = {
	startExpediaReservationCollectorJob,
	submitExpediaReservationMfaCode,
	parsePropertiesFromText,
	matchPropertiesToHotels,
	confirmationCandidatesFromText,
};
