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
	getSarConversionMeta,
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
const KEEP_AUDIT_SCREENSHOTS = /^(1|true|yes)$/i.test(
	process.env.OTA_EXPEDIA_KEEP_AUDIT_SCREENSHOTS || ""
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
const PAGE_SNAPSHOT_TIMEOUT_MS = Number(
	process.env.OTA_EXPEDIA_PAGE_SNAPSHOT_TIMEOUT_MS || 5_000
);
const LOGIN_STEP_TIMEOUT_MS = Number(
	process.env.OTA_EXPEDIA_LOGIN_STEP_TIMEOUT_MS || 20_000
);
const COLLECTOR_HARD_TIMEOUT_MS = Number(
	process.env.OTA_EXPEDIA_COLLECTOR_HARD_TIMEOUT_MS ||
		Math.max(MAX_RUN_MS * 5, 12 * 60 * 1000)
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

const withTimeout = (promise, timeoutMs, message) => {
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([
		Promise.resolve(promise).finally(() => {
			if (timer) clearTimeout(timer);
		}),
		timeout,
	]);
};

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

const buildExpediaBookingItemDetailUrl = (propertyId = "", reservationId = "") => {
	const url = new URL(
		process.env.OTA_EXPEDIA_BOOKINGS_URL || DEFAULT_BOOKINGS_URL,
		expediaAppBaseUrl()
	);
	if (propertyId) url.searchParams.set("htid", String(propertyId));
	if (reservationId) url.searchParams.set("bookingItemId", String(reservationId));
	return url.toString();
};

const reservationIdFromExpediaUrl = (href = "") =>
	normalizeConfirmation(
		String(href || "").match(
			/[?&](?:reservationIds|reservationId|bookingItemId|bookingId)=([A-Z0-9-]+)/i
		)?.[1] || ""
	);

const isExpediaReservationDetailUrl = (href = "") => {
	const raw = String(href || "");
	if (!reservationIdFromExpediaUrl(raw)) return false;
	try {
		const url = new URL(raw, expediaAppBaseUrl());
		if (!/expediapartnercentral\.com$/i.test(url.hostname)) return false;
		return /\/lodging\/(?:bookings|reservations)\b|legacyReservationDetails\.html/i.test(
			url.pathname
		);
	} catch (_) {
		return false;
	}
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

const isoDateOnly = (date) => date.toISOString().slice(0, 10);

const addUtcDays = (date, days) => {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
};

const clampIsoDate = (value, min, max) => {
	if (min && value < min) return min;
	if (max && value > max) return max;
	return value;
};

const recentBookedDateRangeForJob = (job = {}) => {
	const today = isoDateOnly(new Date());
	const recentFrom = isoDateOnly(addUtcDays(new Date(`${today}T00:00:00.000Z`), -2));
	const from = clampIsoDate(recentFrom, job.dateFrom || "", job.dateTo || "");
	const to = clampIsoDate(today, job.dateFrom || "", job.dateTo || "");
	if (!from || !to || from > to) return null;
	return { dateFrom: from, dateTo: to };
};

const ensureDirectory = (dir) => {
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

const collectorOutputDir = () =>
	process.env.OTA_EXPEDIA_SYNC_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;

const collectorProfileDir = () =>
	ensureDirectory(
		process.env.OTA_EXPEDIA_BROWSER_PROFILE_DIR || DEFAULT_PROFILE_DIR
	);

const captureAuditScreenshot = async ({ page, artifacts, fileName }) => {
	if (!KEEP_AUDIT_SCREENSHOTS || !page || !artifacts || !fileName) return;
	const outputDir = ensureDirectory(artifacts.outputDir || collectorOutputDir());
	const screenshotPath = path.join(outputDir, fileName);
	await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
	artifacts.screenshots = Array.isArray(artifacts.screenshots)
		? artifacts.screenshots
		: [];
	artifacts.screenshots.push(screenshotPath);
};

const recoverablePageErrorPattern =
	/(target closed|session closed|target page, context or browser has been closed|requesting main frame too early|frame was detached|execution context was destroyed|cannot find context with specified id|protocol error \(page\.navigate\))/i;

const isRecoverablePageLifecycleError = (error) =>
	recoverablePageErrorPattern.test(error?.message || String(error || ""));

const safePageUrl = (page) => {
	try {
		return page && !page.isClosed?.() ? page.url() : "";
	} catch (_error) {
		return "";
	}
};

const configureCollectorPage = (page) => {
	if (!page) return page;
	page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
	page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
	return page;
};

const waitForUsablePage = async (page) => {
	if (!page || page.isClosed?.()) return false;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			await page.evaluate(() => true);
			return true;
		} catch (error) {
			if (!isRecoverablePageLifecycleError(error)) return true;
			await delay(180);
		}
	}
	return false;
};

const closeRestoredPages = async (browser) => {
	const pages = await browser.pages().catch(() => []);
	for (const page of pages) {
		await page.close({ runBeforeUnload: false }).catch(() => {});
	}
};

const createCollectorPage = async (browser, { closeExisting = false } = {}) => {
	if (closeExisting) {
		await closeRestoredPages(browser);
	}
	const page = configureCollectorPage(await browser.newPage());
	await delay(120);
	await waitForUsablePage(page);
	return page;
};

const gotoCollectorPage = async ({
	browser,
	page,
	url,
	options = {},
	retries = 2,
}) => {
	let currentPage = page;
	for (let attempt = 0; attempt <= retries; attempt += 1) {
		try {
			if (!currentPage || currentPage.isClosed?.()) {
				currentPage = await createCollectorPage(browser);
			}
			await currentPage.goto(url, {
				waitUntil: "domcontentloaded",
				...options,
			});
			await delay(250);
			return currentPage;
		} catch (error) {
			if (!isRecoverablePageLifecycleError(error) || attempt >= retries) {
				throw error;
			}
			if (currentPage?.close) {
				await currentPage.close({ runBeforeUnload: false }).catch(() => {});
			}
			await delay(450 + attempt * 300);
			currentPage = await createCollectorPage(browser);
		}
	}
	return currentPage;
};

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
		if (!page || page.isClosed?.()) {
			return {
				text: "",
				title: "",
				url: "",
				error: "page_closed",
			};
		}
		return await withTimeout(
			page.evaluate(() => ({
				text: document.body.innerText || "",
				title: document.title || "",
				url: window.location.href || "",
			})),
			PAGE_SNAPSHOT_TIMEOUT_MS,
			"page_snapshot_timeout"
		);
	} catch (error) {
		return {
			text: "",
			title: "",
			url: safePageUrl(page),
			error: error && error.message ? error.message : String(error),
		};
	}
};

const stablePageSnapshot = async (page, attempts = 6) => {
	let snapshot = await safePageSnapshot(page);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (!snapshot.error || !isRecoverablePageLifecycleError(snapshot.error)) {
			return snapshot;
		}
		await delay(250 + attempt * 150);
		snapshot = await safePageSnapshot(page);
	}
	return snapshot;
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
		const elements = await withTimeout(
			page.$$(selector),
			LOGIN_STEP_TIMEOUT_MS,
			`input_query_timeout:${selector}`
		).catch(() => []);
		for (const element of elements) {
			if (
				!(await withTimeout(
					isElementVisible(element),
					3_000,
					"input_visibility_timeout"
				).catch(() => false))
			) {
				continue;
			}
			await withTimeout(
				element.click({ clickCount: 3 }),
				5_000,
				"input_click_timeout"
			).catch(() => {});
			await withTimeout(
				page.keyboard.press("Backspace"),
				3_000,
				"input_clear_timeout"
			).catch(() => {});
			await withTimeout(
				element.type(String(value || ""), { delay: 20 }),
				LOGIN_STEP_TIMEOUT_MS,
				"input_type_timeout"
			);
			return true;
		}
	}
	return false;
};

const clickButtonByText = async (page, patterns = []) =>
	page.evaluate((rawPatterns) => {
		const regexes = rawPatterns.map((pattern) => new RegExp(pattern, "i"));
		const normalize = (value) =>
			String(value || "")
				.replace(/\s+/g, " ")
				.trim();
		const joinedText = (values) =>
			Array.from(new Set(values.map(normalize).filter(Boolean))).join(" ");
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
			const text = joinedText([
				node.innerText,
				node.textContent,
				node.value,
				node.getAttribute("aria-label"),
			]);
			return regexes.some((regex) => regex.test(text));
		});
		if (!candidate) return false;
		candidate.click();
		return true;
	}, patterns);

const clickOrPressEnter = async (page, patterns = []) => {
	const clicked = await withTimeout(
		clickButtonByText(page, patterns),
		LOGIN_STEP_TIMEOUT_MS,
		"button_click_timeout"
	).catch(() => false);
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
				url: snapshot.url || safePageUrl(candidate),
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
		const scrollElement = (element) =>
			new Promise((resolve) => {
				let stableRounds = 0;
				let previousHeight = 0;
				const interval = setInterval(() => {
					element.scrollTop += 700;
					const currentHeight = element.scrollHeight;
					const atBottom =
						element.scrollTop + element.clientHeight >= element.scrollHeight - 5;
					if (currentHeight === previousHeight || atBottom) {
						stableRounds += 1;
					} else {
						stableRounds = 0;
						previousHeight = currentHeight;
					}
					if (stableRounds >= 3) {
						clearInterval(interval);
						element.scrollTop = 0;
						resolve();
					}
				}, 180);
			});

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

		const scrollables = Array.from(document.querySelectorAll("*"))
			.filter((node) => {
				const style = window.getComputedStyle(node);
				const rect = node.getBoundingClientRect();
				return (
					node.scrollHeight > node.clientHeight + 120 &&
					rect.width > 0 &&
					rect.height > 0 &&
					style &&
					style.visibility !== "hidden" &&
					style.display !== "none" &&
					/(auto|scroll)/i.test(
						`${style.overflowY || ""} ${style.overflow || ""}`
					)
				);
			})
			.slice(0, 20);
		for (const element of scrollables) {
			// eslint-disable-next-line no-await-in-loop
			await scrollElement(element);
		}
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
	}).catch(async () => {
		const fallback = await safePageSnapshot(page);
		return { text: fallback.text || "", links: [] };
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

const selectBookingsDateMode = async (page, mode = "") => {
	const normalizedMode = normalizeLine(mode).toLowerCase();
	if (!normalizedMode) return false;
	return page
		.evaluate((modeKey) => {
			const patterns =
				modeKey === "booked_on"
					? [/booked\s+on/i, /booking\s+date/i, /^booked$/i]
					: modeKey === "checking_in"
					? [/checking\s+in/i, /check[-\s]?in/i, /arrival/i]
					: modeKey === "checking_out"
					? [/checking\s+out/i, /check[-\s]?out/i, /departure/i]
					: [];
			if (!patterns.length) return false;
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
			const nodes = Array.from(
				document.querySelectorAll(
					"label, button, [role='radio'], [role='button'], input[type='radio']"
				)
			);
			const candidate = nodes.find((node) => {
				if (!visible(node)) return false;
				const labelFor = node.getAttribute("for");
				const labelledInput = labelFor
					? document.getElementById(labelFor)
					: null;
				const text = normalize(
					[
						node.innerText,
						node.textContent,
						node.value,
						node.getAttribute("aria-label"),
						node.getAttribute("title"),
						labelledInput?.getAttribute("aria-label"),
					]
						.filter(Boolean)
						.join(" ")
				);
				return patterns.some((pattern) => pattern.test(text));
			});
			if (!candidate) return false;
			const clickable =
				candidate.closest("label, button, [role='radio'], [role='button']") ||
				candidate;
			clickable.click();
			return true;
		}, normalizedMode)
		.catch(() => false);
};

const applyBookingsDateFilter = async (
	page,
	{ dateFrom = "", dateTo = "", dateMode = "" } = {}
) => {
	const from = toUsDateInput(dateFrom);
	const to = toUsDateInput(dateTo);
	if (!from || !to) {
		return { applied: false, reason: "missing_range" };
	}

	const modeSelected = dateMode
		? await selectBookingsDateMode(page, dateMode)
		: false;
	if (modeSelected) {
		await delay(350);
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
					const type = String(input.type || input.getAttribute("type") || "")
						.toLowerCase()
						.trim();
					if (
						[
							"hidden",
							"radio",
							"checkbox",
							"button",
							"submit",
							"reset",
							"file",
							"image",
						].includes(type)
					) {
						return false;
					}
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
					return /mm\/dd\/yyyy|\bdate\b|\bfrom\b|\bto\b|check[-\s]?(?:in|out)|arrival|departure/i.test(
						hint
					);
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
		dateMode,
		modeSelected,
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

const stayNightsBetween = (checkinDate = "", checkoutDate = "") => {
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(checkinDate) ||
		!/^\d{4}-\d{2}-\d{2}$/.test(checkoutDate)
	) {
		return 0;
	}
	const checkin = new Date(`${checkinDate}T00:00:00.000Z`);
	const checkout = new Date(`${checkoutDate}T00:00:00.000Z`);
	const nights = Math.round((checkout - checkin) / (24 * 60 * 60 * 1000));
	return Number.isFinite(nights) && nights > 0 ? nights : 0;
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
	const amountOnly = fallbackCurrency
		? raw.match(/(^|[^\d])([+-]?\d[\d,]*\.\d{1,2})(?!\d)/)
		: null;
	const currency = currencyFirst?.[1] || amountFirst?.[2] || fallbackCurrency || "";
	const amountText = currencyFirst?.[2] || amountFirst?.[1] || amountOnly?.[2] || "";
	if (!amountText) return null;
	const amount = Number(String(amountText).replace(/,/g, ""));
	if (!Number.isFinite(amount)) return null;
	return {
		currency,
		amount,
		raw,
	};
};

const moneyNumber = (value) => {
	const numeric = Number(value || 0);
	return Number.isFinite(numeric) ? numeric : 0;
};

const toSarMoneyMeta = (amount, currency) =>
	getSarConversionMeta(moneyNumber(amount), currency || "SAR");

const convertSummaryAmountToSar = (amount, currency) => {
	const numeric = moneyNumber(amount);
	if (!numeric) return 0;
	return toSarMoneyMeta(numeric, currency).totalAmountSar;
};

const normalizeCandidateMoneyToSar = (candidate = {}) => {
	const summary = candidate.paymentSummary || {};
	const sourceCurrency =
		candidate.sourceCurrency ||
		candidate.currency ||
		summary.sourceCurrency ||
		summary.currency ||
		"SAR";
	const sourceAmount = moneyNumber(
		candidate.sourceAmount ||
			candidate.amount ||
			summary.sourceTotalGuestPaymentAmount ||
			summary.totalGuestPaymentAmount
	);
	const conversion = toSarMoneyMeta(sourceAmount, sourceCurrency);
	const summaryCurrency = summary.sourceCurrency || summary.currency || sourceCurrency;
	const sourceNightlyRateAmount = moneyNumber(
		summary.sourceNightlyRateAmount || summary.nightlyRateAmount
	);
	const sourceTaxesAmount = moneyNumber(
		summary.sourceTaxesAmount || summary.taxesAmount
	);
	const sourceTotalGuestPaymentAmount = moneyNumber(
		summary.sourceTotalGuestPaymentAmount ||
			summary.totalGuestPaymentAmount ||
			sourceAmount
	);
	const sourceExpediaCompensationAmount = moneyNumber(
		summary.sourceExpediaCompensationAmount || summary.expediaCompensationAmount
	);
	const sourceAcceleratorAmount = moneyNumber(
		summary.sourceAcceleratorAmount || summary.acceleratorAmount
	);
	const sourceTotalPayoutAmount = moneyNumber(
		summary.sourceTotalPayoutAmount || summary.totalPayoutAmount
	);

	return {
		...candidate,
		sourceAmount,
		sourceCurrency: conversion.sourceCurrency || sourceCurrency,
		sourceAmountHint: candidate.sourceAmountHint || candidate.amountHint || "",
		amountHint: conversion.totalAmountSar
			? `SAR ${conversion.totalAmountSar.toFixed(2)}`
			: "",
		exchangeRateToSar: conversion.exchangeRateToSar,
		exchangeRateSource: conversion.exchangeRateSource,
		totalAmountSar: conversion.totalAmountSar,
		amountConvertedAt: conversion.convertedAt,
		amount: conversion.totalAmountSar,
		currency: "SAR",
		paymentSummary: {
			...summary,
			sourceCurrency: summaryCurrency,
			sourceNightlyRateAmount,
			sourceTaxesAmount,
			sourceTotalGuestPaymentAmount,
			sourceExpediaCompensationAmount,
			sourceAcceleratorAmount,
			sourceTotalPayoutAmount,
			nightlyRateAmount: convertSummaryAmountToSar(
				sourceNightlyRateAmount,
				summaryCurrency
			),
			taxesAmount: convertSummaryAmountToSar(sourceTaxesAmount, summaryCurrency),
			totalGuestPaymentAmount:
				convertSummaryAmountToSar(sourceTotalGuestPaymentAmount, summaryCurrency) ||
				conversion.totalAmountSar,
			expediaCompensationAmount: convertSummaryAmountToSar(
				sourceExpediaCompensationAmount,
				summaryCurrency
			),
			acceleratorAmount: convertSummaryAmountToSar(
				sourceAcceleratorAmount,
				summaryCurrency
			),
			totalPayoutAmount: convertSummaryAmountToSar(
				sourceTotalPayoutAmount,
				summaryCurrency
			),
			currency: "SAR",
			exchangeRateToSar: conversion.exchangeRateToSar,
			exchangeRateSource: conversion.exchangeRateSource,
			amountConvertedAt: conversion.convertedAt,
		},
	};
};

const parseExpediaStatusToApply = (value = "") => {
	const text = normalizeLine(value).toLowerCase();
	if (/cancelled|canceled/.test(text)) return "cancelled";
	if (/no[-\s]?show/.test(text)) return "no_show";
	if (/booked|confirmed|recent|unconfirmed/.test(text)) return "confirmed";
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
			"a[href*='bookingItemId']",
			"a[href*='reservationIds']",
			"a[href*='reservationId']",
			"[data-testid]",
			"[data-stid]",
			"li",
			"article",
			"section",
			"div",
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
				const links = [
					...(node.matches?.("a[href]") ? [node] : []),
					...Array.from(node.querySelectorAll("a[href]")),
				];
				const reservationLink = links.find((link) => {
					const href = String(link.href || "");
					return (
						/[?&](?:reservationIds|reservationId|bookingItemId|bookingId)=/i.test(
							href
						) &&
						/expediapartnercentral\.com/i.test(href) &&
						/\/lodging\/(?:bookings|reservations)\b|legacyReservationDetails\.html/i.test(
							href
						)
					);
				});
				const href = reservationLink ? reservationLink.href : "";
				return { text, lines, cells, href };
			})
			.filter((row) => {
				if (!row.text || row.text.length < 12) return false;
				if (row.text.length > 1600) return false;
				if (!/\b\d{8,16}\b/.test(row.text) && !/\b(?:bookingItemId|reservationIds)=/i.test(row.href || "")) {
					return false;
				}
				if (
					!/(recent|unconfirmed|confirmed|cancelled|canceled|no[-\s]?show|check[-\s]?in|check[-\s]?out|room|suite|bed|view|booked|booking|guest|expedia|collect|usd|sar|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)/i.test(
						row.text
					)
				) {
					return false;
				}
				if (/^(guest|reservation|confirmation|check[-\s]?in|check[-\s]?out|room|booked on|booking amount)\b/i.test(row.text)) {
					return false;
				}
				if (seen.has(row.text)) return false;
				seen.add(row.text);
				return true;
			})
			.sort((left, right) => {
				const score = (row) => {
					const text = row.text || "";
					return (
						(row.cells?.length || 0) * 10 +
						(row.lines?.length || 0) * 4 +
						(/\b\d{8,16}\b/.test(text) ? 20 : 0) +
						(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(text) ? 20 : 0) +
						(/room|suite|bed|view/i.test(text) ? 10 : 0) +
						(/USD|SAR|Expedia Collect|Hotel Collect/i.test(text) ? 10 : 0) +
						Math.min(text.length / 80, 12)
					);
				};
				return score(right) - score(left);
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
		const currentLine = normalizeLine(lines[index]);
		if (!regex.test(currentLine)) continue;
		const sameLineMoney = parseMoneyValue(currentLine, fallbackCurrency);
		if (sameLineMoney) return sameLineMoney;
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

const moneyNearLabel = (
	text = "",
	labelPattern,
	fallbackCurrency = "",
	maxLookahead = 320
) => {
	const source = normalizeWhitespace(text);
	if (!source) return null;
	const regex =
		labelPattern instanceof RegExp
			? new RegExp(labelPattern.source, `${labelPattern.flags || ""}`.replace("g", ""))
			: new RegExp(labelPattern, "i");
	const match = regex.exec(source);
	if (!match) return null;
	const after = source.slice(
		match.index + match[0].length,
		match.index + match[0].length + maxLookahead
	);
	return parseMoneyValue(after, fallbackCurrency);
};

const paymentDetailLabels = [
	{ key: "nightlyRateAmount", pattern: /^Nightly rates?/i },
	{ key: "promotionAmount", pattern: /^Promotion\b/i },
	{ key: "taxesAmount", pattern: /^Taxes\b/i },
	{ key: "totalGuestPaymentAmount", pattern: /^Total guest payment\b/i },
	{
		key: "expediaCompensationAmount",
		pattern: /^Expedia Group'?s compensation\b/i,
	},
	{ key: "acceleratorAmount", pattern: /^Accelerator\b/i },
	{ key: "totalPayoutAmount", pattern: /^Your total payout\b/i },
	{
		key: "totalPayoutAmount",
		pattern: /^Amount to charge Expedia Group\b/i,
		auxiliary: true,
	},
];

const matchPaymentDetailLabel = (line = "") => {
	const text = normalizeLine(line);
	return (
		paymentDetailLabels.find((label) => label.pattern.test(text)) || null
	);
};

const parsePaymentMoneyAtLine = (lines = [], index = 0, fallbackCurrency = "") => {
	const line = normalizeLine(lines[index]);
	const sameLine = parseMoneyValue(line, fallbackCurrency);
	if (sameLine) return { money: sameLine, consumedNext: false };
	if (/^[A-Z]{3}$/i.test(line)) {
		const nextLine = normalizeLine(lines[index + 1]);
		const combined = parseMoneyValue(`${line.toUpperCase()} ${nextLine}`, "");
		if (combined) return { money: combined, consumedNext: true };
	}
	return { money: null, consumedNext: false };
};

const parseExpediaPaymentDetailsFromLines = (lines = [], fallbackCurrency = "") => {
	const startIndex = lines.findIndex((line) =>
		/payment details|expedia collects payment/i.test(line)
	);
	const section =
		startIndex >= 0 ? lines.slice(startIndex, startIndex + 90) : lines.slice(0, 90);
	const labelEvents = [];
	const amountEvents = [];
	for (let index = 0; index < section.length; index += 1) {
		const line = normalizeLine(section[index]);
		const label = matchPaymentDetailLabel(line);
		if (label) {
			const previous = labelEvents[labelEvents.length - 1];
			if (
				!(
					label.auxiliary &&
					previous &&
					previous.key === label.key &&
					previous.value === undefined
				)
			) {
				labelEvents.push({ key: label.key, index });
			}
		}
		const { money, consumedNext } = parsePaymentMoneyAtLine(
			section,
			index,
			fallbackCurrency
		);
		if (money) {
			amountEvents.push({ index, money });
			if (label && labelEvents.length) {
				labelEvents[labelEvents.length - 1].value = money;
			}
		}
		if (consumedNext) index += 1;
	}
	const output = {};
	for (const label of labelEvents) {
		if (label.value && output[label.key] === undefined) {
			output[label.key] = label.value;
		}
	}
	const firstAmountIndex = amountEvents[0]?.index ?? -1;
	const lastLabelIndex = labelEvents[labelEvents.length - 1]?.index ?? -1;
	const columnarAmounts =
		labelEvents.length >= 3 &&
		amountEvents.length >= labelEvents.length - 1 &&
		firstAmountIndex > lastLabelIndex;

	if (columnarAmounts) {
		labelEvents.forEach((label, index) => {
			if (output[label.key] !== undefined) return;
			const money = amountEvents[index]?.money;
			if (money) output[label.key] = money;
		});
		return output;
	}

	labelEvents.forEach((label, index) => {
		if (output[label.key] !== undefined) return;
		const nextLabelIndex = labelEvents[index + 1]?.index ?? Number.POSITIVE_INFINITY;
		const money = amountEvents.find(
			(entry) => entry.index > label.index && entry.index < nextLabelIndex
		)?.money;
		if (money) output[label.key] = money;
	});

	labelEvents.forEach((label, index) => {
		if (output[label.key] !== undefined) return;
		const money = amountEvents[index]?.money;
		if (money) output[label.key] = money;
	});

	return output;
};

const paymentSectionSnippet = (text = "") => {
	const safeText = normalizeWhitespace(redactSensitive(text));
	const markers = [
		/payment details/i,
		/total guest payment/i,
		/your total payout/i,
		/expedia group'?s compensation/i,
		/expedia collects payment/i,
	];
	const marker = markers
		.map((regex, priority) => {
			const match = regex.exec(safeText);
			return match ? { index: match.index, priority } : null;
		})
		.filter(Boolean)
		.sort((left, right) => {
			if (left.priority !== right.priority) return left.priority - right.priority;
			return left.index - right.index;
		})[0];
	if (!marker) return "";
	return safeText.slice(Math.max(0, marker.index - 120), marker.index + 1600);
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
		detectCurrency(rawText) || detectCurrency(candidate.amountHint) || candidate.currency;
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
	const paymentDetails = parseExpediaPaymentDetailsFromLines(
		lines,
		fallbackCurrency
	);

	const dateRangeMatch = String(rawText || "").match(
		/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\s*(?:[\u2013\u2014-]|to)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})(?:\s*\((\d+)\s*nights?\))?/i
	);
	const allDates = extractExpediaDates(rawText);
	const parsedCheckinDate = parseExpediaDate(dateRangeMatch?.[1]);
	const parsedCheckoutDate = parseExpediaDate(dateRangeMatch?.[2]);
	let checkinDate = parsedCheckinDate || candidate.checkinDate || allDates[0]?.iso || "";
	let checkoutDate =
		parsedCheckoutDate || candidate.checkoutDate || allDates[1]?.iso || "";
	if (!stayNightsBetween(checkinDate, checkoutDate)) {
		if (stayNightsBetween(candidate.checkinDate, candidate.checkoutDate)) {
			checkinDate = candidate.checkinDate;
			checkoutDate = candidate.checkoutDate;
		} else if (stayNightsBetween(allDates[0]?.iso, allDates[1]?.iso)) {
			checkinDate = allDates[0].iso;
			checkoutDate = allDates[1].iso;
		}
	}
	const nights =
		stayNightsBetween(checkinDate, checkoutDate) ||
		Number(dateRangeMatch?.[3] || 0) ||
		candidate.nights ||
		0;
	const bookedAt =
		parseExpediaDate(reservationMadeRaw) ||
		candidate.bookedAt ||
		(allDates.length > 2 ? allDates[2].iso : "");

	const nightlyRate =
		paymentDetails.nightlyRateAmount ||
		moneyAfterLine(lines, /^Nightly rates?/i, fallbackCurrency) ||
		moneyNearLabel(rawText, /Nightly rates?(?:\s*\([^)]*\))?/i, fallbackCurrency);
	const taxes =
		paymentDetails.taxesAmount ||
		moneyAfterLine(lines, /^Taxes$/i, fallbackCurrency) ||
		moneyNearLabel(rawText, /\bTaxes\b/i, fallbackCurrency);
	const totalGuestPayment =
		paymentDetails.totalGuestPaymentAmount ||
		moneyAfterLine(lines, /^Total guest payment$/i, fallbackCurrency) ||
		moneyNearLabel(rawText, /Total guest payment/i, fallbackCurrency);
	const expediaCompensation =
		paymentDetails.expediaCompensationAmount ||
		moneyAfterLine(
			lines,
			/^Expedia Group'?s compensation$/i,
			fallbackCurrency
		) ||
		moneyNearLabel(rawText, /Expedia Group'?s compensation/i, fallbackCurrency);
	const accelerator =
		paymentDetails.acceleratorAmount ||
		moneyAfterLine(lines, /^Accelerator/i, fallbackCurrency) ||
		moneyNearLabel(rawText, /Accelerator(?:\s*\([^)]*\))?/i, fallbackCurrency);
	const totalPayout =
		paymentDetails.totalPayoutAmount ||
		moneyAfterLine(lines, /^Your total payout$/i, fallbackCurrency, 8) ||
		moneyAfterLine(lines, /^Amount to charge Expedia Group$/i, fallbackCurrency, 6) ||
		moneyNearLabel(
			rawText,
			/Your total payout(?:\s+Amount to charge Expedia Group)?/i,
			fallbackCurrency,
			420
		) ||
		moneyNearLabel(rawText, /Amount to charge Expedia Group/i, fallbackCurrency, 260);
	const amount = totalGuestPayment || parseMoneyValue(candidate.amountHint, fallbackCurrency);
	const bookingTableAmount = candidate.amount || 0;
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
			totalGuestPaymentAmount:
				totalGuestPayment?.amount ||
				candidate.paymentSummary?.totalGuestPaymentAmount ||
				bookingTableAmount ||
				0,
			expediaCompensationAmount: expediaCompensation?.amount || 0,
			acceleratorAmount: accelerator?.amount || 0,
			totalPayoutAmount: totalPayout?.amount || 0,
			currency:
				totalPayout?.currency ||
				amount?.currency ||
				candidate.currency ||
				fallbackCurrency ||
				"",
		},
		paymentSignals: {
			hasPaymentDetails: hasSensitivePaymentSignal(rawText),
			hasVirtualCardSignal: /virtual\s+card|card\s+number|cvv|cvc/i.test(
				rawText || ""
			),
			rawCardStored: false,
		},
		paymentSectionSnippet: paymentSectionSnippet(rawText),
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

const scopedReservationText = (text = "", reservationId = "") => {
	const source = normalizeWhitespace(text);
	const id = normalizeConfirmation(reservationId);
	if (!source || !id) return source;
	const index = source.indexOf(id);
	if (index < 0) return source;
	const before = source.slice(Math.max(0, index - 90), index);
	const after = source.slice(index, index + 520);
	return normalizeWhitespace(`${before} ${after}`);
};

const guestNameBeforeReservationId = (text = "", reservationId = "") => {
	const id = normalizeConfirmation(reservationId);
	const index = id ? text.indexOf(id) : -1;
	if (index < 0) return "";
	const before = normalizeWhitespace(text.slice(0, index));
	const match = before.match(
		/([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,4})$/
	);
	return isLikelyGuestName(match?.[1]) ? normalizeLine(match[1]) : "";
};

const parseReservationRowCandidate = (row, hotel, property) => {
	const text = normalizeWhitespace(row.text || "");
	if (!text || !/\b\d{8,16}\b/.test(text)) return null;
	const ids = Array.from(
		new Set(confirmationCandidatesFromText(text).map(normalizeConfirmation))
	).filter((value) => value && /^\d{8,16}$/.test(value));
	const hrefReservationId = normalizeConfirmation(
		String(row.href || "").match(
			/[?&](?:reservationIds|reservationId|bookingItemId|bookingId)=([A-Z0-9-]+)/i
		)?.[1] || ""
	);
	const reservationId = hrefReservationId || ids[0] || "";
	if (!reservationId) return null;
	const scopedText = scopedReservationText(text, reservationId);
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
		guestNameBeforeReservationId(scopedText, reservationId) ||
		lines.slice(0, 4).find(isLikelyGuestName) ||
		"";
	const dates = extractExpediaDates(scopedText);
	const amountCell = cells.find((cell) => parseMoneyValue(cell));
	const amount = parseMoneyValue(amountCell || scopedText);
	const roomName =
		cells.find(
			(cell) =>
				/(room|suite|studio|apartment|bed|view)/i.test(cell) &&
				!/(booking amount|room$|rooms and rates)/i.test(cell)
		) ||
		lines.find(
			(line) =>
				/(room|suite|studio|apartment|bed|view)/i.test(line) &&
				!/(booking amount|rooms and rates|^room$|modify reservation|cancellation policy|payment summary)/i.test(
					line
				) &&
				line.length <= 140
		) ||
		"";
	const rowDetailUrl = isExpediaReservationDetailUrl(row.href) ? row.href : "";
	const detailUrl =
		rowDetailUrl ||
		buildExpediaReservationDetailUrl(property.expediaPropertyId, reservationId);
	const modernDetailUrl = buildExpediaBookingItemDetailUrl(
		property.expediaPropertyId,
		reservationId
	);
	const details = parseLightReservationDetails(scopedText);
	const statusRaw = /cancelled|canceled/i.test(scopedText)
		? "Cancelled"
		: /no[-\s]?show/i.test(scopedText)
		? "No Show"
		: /unconfirmed/i.test(scopedText)
		? "Unconfirmed"
		: /booked|confirmed/i.test(scopedText)
		? "Booked"
		: /recent/i.test(scopedText)
		? "Recent"
		: "";

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
		currency: amount?.currency || detectCurrency(scopedText),
		amount: amount?.amount || 0,
		amountHint: amount?.raw || details.amountHint || "",
		paymentCollectionModel: detectExpediaPaymentCollectionModel(scopedText),
		detailUrl,
		modernDetailUrl,
		sourceUrl: detailUrl || row.href || "",
		sourceSnippet: safeSnippet(scopedText, 700),
	};
};

const paymentDetailsPanelReadyPattern =
	/(your total payout|amount to charge expedia group|expedia group'?s compensation|nightly rates?\s*\(|accelerator|promotion\.)/i;

const isPaymentDetailsPanelOpen = async (page, timeout = 700) =>
	Boolean(
		await page
			.waitForFunction(
				(patternSource) =>
					new RegExp(patternSource, "i").test(document.body?.innerText || ""),
				{ timeout },
				paymentDetailsPanelReadyPattern.source
			)
			.catch(() => false)
	);

const clickPaymentDetailsTrigger = async (page) => {
	const target = await page
		.evaluate(() => {
			const normalize = (value) =>
				String(value || "")
					.replace(/\s+/g, " ")
					.trim();
			const joinedText = (values) =>
				Array.from(new Set(values.map(normalize).filter(Boolean))).join(" ");
			const visible = (node) => {
				if (!node || !(node instanceof HTMLElement)) return false;
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
			const clickableSelector =
				"button, input[type='button'], input[type='submit'], a, summary, [role='button'], [tabindex]";
			const clickableFor = (node) =>
				node?.closest?.(clickableSelector) || node;
			const allNodes = Array.from(document.querySelectorAll("body *"));
			const candidates = allNodes
				.map((rawNode) => {
					const node = clickableFor(rawNode);
					if (!visible(node)) return null;
					const text = joinedText([
						rawNode.innerText,
						rawNode.textContent,
						node.innerText,
						node.textContent,
						node.value,
						node.getAttribute("aria-label"),
						node.getAttribute("title"),
						node.getAttribute("data-testid"),
						node.getAttribute("data-stid"),
					]);
					if (!/payment details|nightly payment details/i.test(text)) {
						return null;
					}
					if (/close|hide|collapse/i.test(text)) return null;
					if (!/see|view|show|open|payment details/i.test(text)) return null;
					const rect = node.getBoundingClientRect();
					const ancestorText = normalize(
						node.closest("section, article, aside, div")?.innerText || ""
					);
					const exact = /^see payment details$/i.test(text);
					const isButton = /^(BUTTON|A|SUMMARY)$/i.test(node.tagName);
					const inPaymentSummary = /payment summary/i.test(ancestorText);
					const huge = rect.width > window.innerWidth * 0.75 || rect.height > 220;
					return {
						node,
						text,
						rect,
						score:
							(exact ? 0 : 30) +
							(isButton ? 0 : 10) +
							(inPaymentSummary ? 0 : 8) +
							(huge ? 25 : 0) +
							Math.min(text.length, 140) / 20 +
							rect.width / 1000 +
							rect.height / 1000,
					};
				})
				.filter(Boolean)
				.sort((left, right) => left.score - right.score);
			const best = candidates[0];
			if (!best) return null;
			best.node.scrollIntoView({ block: "center", inline: "center" });
			const rect = best.node.getBoundingClientRect();
			const token = `jannat_payment_${Date.now()}_${Math.random()
				.toString(36)
				.slice(2)}`;
			best.node.setAttribute("data-jannat-payment-trigger", token);
			return {
				token,
				text: best.text,
				x: rect.left + rect.width / 2,
				y: rect.top + rect.height / 2,
			};
		})
		.catch(() => null);
	if (!target) return { clicked: false };

	await page.mouse.move(target.x, target.y).catch(() => {});
	await page.mouse.down().catch(() => {});
	await delay(80);
	await page.mouse.up().catch(() => {});
	await delay(300);
	await page
		.evaluate((token) => {
			const node = document.querySelector(
				`[data-jannat-payment-trigger="${token}"]`
			);
			if (!node) return;
			if (typeof node.focus === "function") node.focus();
			for (const eventName of ["pointerdown", "mousedown", "mouseup", "click"]) {
				node.dispatchEvent(
					new MouseEvent(eventName, {
						bubbles: true,
						cancelable: true,
						view: window,
					})
				);
			}
			if (typeof node.click === "function") node.click();
		}, target.token)
		.catch(() => {});
	await page.keyboard.press("Enter").catch(() => {});
	await delay(250);
	await page.keyboard.press("Space").catch(() => {});
	return { clicked: true, text: target.text };
};

const clickSeeAllReservationDetails = async (page) => {
	const target = await page
		.evaluate(() => {
			const normalize = (value) =>
				String(value || "")
					.replace(/\s+/g, " ")
					.trim();
			const joinedText = (values) =>
				Array.from(new Set(values.map(normalize).filter(Boolean))).join(" ");
			const visible = (node) => {
				if (!node || !(node instanceof HTMLElement)) return false;
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
			const selector =
				"button, input[type='button'], input[type='submit'], a, [role='button'], [tabindex]";
			const candidates = Array.from(document.querySelectorAll(selector))
				.map((node) => {
					if (!visible(node)) return null;
					const text = joinedText(
						[
							node.innerText,
							node.textContent,
							node.value,
							node.getAttribute("aria-label"),
							node.getAttribute("title"),
						]
					);
					if (!/see all reservation details/i.test(text)) return null;
					const rect = node.getBoundingClientRect();
					const exact = /^see all reservation details$/i.test(text);
					const isNativeButton = /^(BUTTON|A|INPUT)$/i.test(node.tagName);
					const huge =
						rect.width > window.innerWidth * 0.7 || rect.height > 180;
					const token = `jannat_full_details_${Date.now()}_${Math.random()
						.toString(36)
						.slice(2)}`;
					node.setAttribute("data-jannat-full-details-trigger", token);
					return {
						token,
						text,
						x: rect.left + rect.width / 2,
						y: rect.top + rect.height / 2,
						score:
							(exact ? 0 : 30) +
							(isNativeButton ? 0 : 12) +
							(huge ? 120 : 0) +
							Math.min(text.length, 180) / 20 +
							rect.width / 1000 +
							rect.height / 1000,
					};
				})
				.filter(Boolean)
				.sort((left, right) => left.score - right.score);
			return candidates[0] || null;
		})
		.catch(() => null);
	if (!target) return { clicked: false };

	const navigation = Promise.race([
		page
			.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 9000 })
			.catch(() => null),
		page
			.waitForFunction(
				() =>
					/(expedia collects payment|your total payout|amount to charge expedia group|nightly rates)/i.test(
						document.body?.innerText || ""
					),
				{ timeout: 9000 }
			)
			.catch(() => null),
	]);
	await page.mouse.click(target.x, target.y).catch(() => {});
	await delay(300);
	await page
		.evaluate((token) => {
			const node = document.querySelector(
				`[data-jannat-full-details-trigger="${token}"]`
			);
			if (!node) return;
			if (typeof node.focus === "function") node.focus();
			for (const eventName of ["pointerdown", "mousedown", "mouseup", "click"]) {
				node.dispatchEvent(
					new MouseEvent(eventName, {
						bubbles: true,
						cancelable: true,
						view: window,
					})
				);
			}
			if (typeof node.click === "function") node.click();
		}, target.token)
		.catch(() => {});
	await page.keyboard.press("Enter").catch(() => {});
	await delay(250);
	await page.keyboard.press("Space").catch(() => {});
	await navigation;
	return { clicked: true, text: target.text };
};

const expandReservationPaymentSections = async (page) => {
	if (await isPaymentDetailsPanelOpen(page)) return true;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const clickResult = await clickPaymentDetailsTrigger(page);
		if (!clickResult.clicked) return false;
		if (await isPaymentDetailsPanelOpen(page, 6500)) return true;
		await delay(500 + attempt * 250);
	}
	return await isPaymentDetailsPanelOpen(page, 1200);
};

const collectPaymentExpansionDiagnostics = async (page) =>
	page
		.evaluate(() => {
			const normalize = (value) =>
				String(value || "")
					.replace(/\s+/g, " ")
					.trim();
			const visible = (node) => {
				if (!node || !(node instanceof HTMLElement)) return false;
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
			return Array.from(
				document.querySelectorAll(
					"button, a, summary, [role='button'], [tabindex], input[type='button'], input[type='submit']"
				)
			)
				.map((node) => {
					if (!visible(node)) return null;
					const text = normalize(
						[
							node.innerText,
							node.textContent,
							node.value,
							node.getAttribute("aria-label"),
							node.getAttribute("title"),
							node.getAttribute("data-testid"),
							node.getAttribute("data-stid"),
						]
							.filter(Boolean)
							.join(" ")
					);
					if (!/(payment|payout|charge expedia|reservation details)/i.test(text)) {
						return null;
					}
					const rect = node.getBoundingClientRect();
					const style = window.getComputedStyle(node);
					const attributes = Array.from(node.attributes || [])
						.map((attribute) => [attribute.name, attribute.value])
						.filter(([name]) => /^(aria-|data-|role$|type$|href$|formaction$|id$|class$)/i.test(name))
						.slice(0, 30);
					return {
						tag: node.tagName,
						role: node.getAttribute("role") || "",
						attributes: Object.fromEntries(attributes),
						disabled: Boolean(node.disabled),
						pointerEvents: style.pointerEvents || "",
						text: text.slice(0, 180),
						html: String(node.outerHTML || "")
							.replace(/\s+/g, " ")
							.slice(0, 700),
						rect: {
							x: Math.round(rect.x),
							y: Math.round(rect.y),
							width: Math.round(rect.width),
							height: Math.round(rect.height),
						},
					};
				})
				.filter(Boolean)
				.slice(0, 30);
		})
		.catch(() => []);

const extractReservationPaymentDisplayText = async (page) =>
	page
		.evaluate(() => {
			const normalize = (value) =>
				String(value || "")
					.replace(/\s+/g, " ")
					.trim();
			const rootSelectors = [
				"#page-template-supply-paymentdisplay",
				"[id*='supply-paymentdisplay' i]",
				"[id*='paymentdisplay' i]",
				"[class*='payment-display' i]",
				"[class*='paymentdisplay' i]",
			];
			const roots = Array.from(
				new Set(
					rootSelectors.flatMap((selector) =>
						Array.from(document.querySelectorAll(selector))
					)
				)
			);
			if (!roots.length) {
				const candidate = Array.from(document.querySelectorAll("section, div, article"))
					.filter((node) => {
						const text = normalize(node.innerText || node.textContent || "");
						return (
							/payment details/i.test(text) &&
							/(nightly rates|taxes|total guest payment|your total payout)/i.test(
								text
							)
						);
					})
					.sort(
						(left, right) =>
							normalize(left.innerText || left.textContent || "").length -
							normalize(right.innerText || right.textContent || "").length
					)[0];
				if (candidate) roots.push(candidate);
			}
			const texts = roots
				.map((node) => node.innerText || node.textContent || "")
				.map((text) => text.trim())
				.filter((text) =>
					/(payment details|nightly rates|taxes|total guest payment|your total payout)/i.test(
						text
					)
				);
			return Array.from(new Set(texts)).join("\n");
		})
		.catch(() => "");

const hasPaymentSummaryPayout = (summary = {}) =>
	Number(summary.totalPayoutAmount || 0) > 0 ||
	Number(summary.sourceTotalPayoutAmount || 0) > 0;

const hasPaymentSummaryGuestTotal = (summary = {}) =>
	Number(summary.totalGuestPaymentAmount || 0) > 0 ||
	Number(summary.sourceTotalGuestPaymentAmount || 0) > 0;

const mergePaymentSummaries = (
	base = {},
	incoming = {},
	{ sourceCurrency = "" } = {}
) => {
	const merged = { ...(base || {}) };
	for (const [field, value] of Object.entries(incoming || {})) {
		if (value === undefined || value === null || value === "") continue;
		if (
			typeof value === "number" &&
			value === 0 &&
			Number(merged[field] || 0) > 0
		) {
			continue;
		}
		if (
			field === "sourceCurrency" &&
			merged.sourceCurrency &&
			merged.sourceCurrency !== value
		) {
			continue;
		}
		if (
			/^source/.test(field) &&
			merged[field] !== undefined &&
			merged[field] !== null &&
			merged[field] !== "" &&
			!(typeof merged[field] === "number" && merged[field] === 0)
		) {
			continue;
		}
		merged[field] = value;
	}
	if (sourceCurrency) merged.sourceCurrency = sourceCurrency;
	return merged;
};

const detailValues = (detail = {}) =>
	Object.fromEntries(
		Object.entries(detail).filter(([field, value]) => {
			if (field === "paymentSummary") return false;
			if (Array.isArray(value)) return value.length > 0;
			if (value && typeof value === "object") return true;
			return value !== undefined && value !== null && value !== "";
		})
	);

const mergeDetailCandidate = ({ candidate = {}, detail = {}, snapshot = {}, detailUrl = "" }) => {
	const mergedPaymentSummary = mergePaymentSummaries(
		candidate.paymentSummary,
		detail.paymentSummary,
		{ sourceCurrency: candidate.sourceCurrency || "" }
	);
	return normalizeCandidateMoneyToSar({
		...candidate,
		...detailValues(detail),
		paymentSummary: mergedPaymentSummary,
		sourceUrl: snapshot.url || detailUrl || candidate.sourceUrl,
		detailUrl: candidate.detailUrl || detailUrl,
		modernDetailUrl: candidate.modernDetailUrl || "",
	});
};

const readReservationDetailFromCurrentPage = async (page) => {
	await page
		.waitForFunction(
			() =>
				/(payment details|expedia collects payment|total guest payment|your total payout|amount to charge expedia group)/i.test(
					document.body?.innerText || ""
				),
			{ timeout: 9000 }
		)
		.catch(() => null);
	await scrollToLoadVisibleContent(page).catch(() => {});
	await expandReservationPaymentSections(page).catch(() => false);
	await scrollToLoadVisibleContent(page).catch(() => {});
	const snapshot = await safePageSnapshot(page);
	const paymentDisplayText = await extractReservationPaymentDisplayText(page);
	const detailText = [snapshot.text, paymentDisplayText].filter(Boolean).join("\n");
	return {
		snapshot,
		detailText,
	};
};

const enrichCandidateFromDetailPage = async (page, candidate) => {
	if (!candidate.detailUrl) return candidate;
	await page.goto(candidate.detailUrl, { waitUntil: "domcontentloaded" });
	await delay(1200);
	let detailRead = await readReservationDetailFromCurrentPage(page);
	let detail = parseExpediaReservationDetailText(detailRead.detailText, candidate);
	let enriched = mergeDetailCandidate({
		candidate,
		detail,
		snapshot: detailRead.snapshot,
		detailUrl: candidate.detailUrl,
	});
	const loadedLegacyDetailUrl = /legacyReservationDetails\.html/i.test(
		detailRead.snapshot.url || candidate.detailUrl || ""
	);
	const legacyDetailHadPaymentSurface =
		/(payment details|expedia collects payment|total guest payment|your total payout|amount to charge expedia group)/i.test(
			detailRead.detailText || ""
		);
	const shouldRetryLegacyDetail =
		candidate.detailUrl &&
		!hasPaymentSummaryPayout(enriched.paymentSummary) &&
		(!loadedLegacyDetailUrl || !legacyDetailHadPaymentSurface);
	if (shouldRetryLegacyDetail) {
		await page.goto(candidate.detailUrl, { waitUntil: "domcontentloaded" });
		await delay(1800);
		detailRead = await readReservationDetailFromCurrentPage(page);
		detail = parseExpediaReservationDetailText(detailRead.detailText, enriched);
		enriched = mergeDetailCandidate({
			candidate: enriched,
			detail,
			snapshot: detailRead.snapshot,
			detailUrl: candidate.detailUrl,
		});
	}

	const shouldTryModernDrawer =
		candidate.modernDetailUrl &&
		candidate.modernDetailUrl !== candidate.detailUrl &&
		(!hasPaymentSummaryPayout(enriched.paymentSummary) ||
			!hasPaymentSummaryGuestTotal(enriched.paymentSummary));
	if (shouldTryModernDrawer) {
		await page.goto(candidate.modernDetailUrl, { waitUntil: "domcontentloaded" });
		await delay(1200);
		const modernRead = await readReservationDetailFromCurrentPage(page);
		const modernDetail = parseExpediaReservationDetailText(
			modernRead.detailText,
			enriched
		);
		enriched = mergeDetailCandidate({
			candidate: enriched,
			detail: modernDetail,
			snapshot: modernRead.snapshot,
			detailUrl: candidate.modernDetailUrl,
		});
	}

	const shouldTryFullDetailsFromDrawer =
		candidate.modernDetailUrl && !hasPaymentSummaryPayout(enriched.paymentSummary);
	if (shouldTryFullDetailsFromDrawer) {
		const fullDetailsClick = await clickSeeAllReservationDetails(page).catch(() => ({
			clicked: false,
		}));
		if (fullDetailsClick.clicked) {
			await delay(1500);
			const fullRead = await readReservationDetailFromCurrentPage(page);
			const fullDetail = parseExpediaReservationDetailText(
				fullRead.detailText,
				enriched
			);
			enriched = mergeDetailCandidate({
				candidate: enriched,
				detail: fullDetail,
				snapshot: fullRead.snapshot,
				detailUrl: fullRead.snapshot.url || candidate.detailUrl,
			});
		}
	}

	if (!hasPaymentSummaryPayout(enriched.paymentSummary)) {
		enriched.paymentExpansionDiagnostics =
			await collectPaymentExpansionDiagnostics(page);
	}

	return enriched;
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

	return candidates.map((candidate) =>
		normalizeCandidateMoneyToSar({
			...candidate,
			detailsFetched: false,
			detailsSkippedReason: "row_scan_pending_classification",
		})
	);
};

const reservationCandidateKey = (candidate = {}) =>
	`${candidate.hotelId || ""}:${
		normalizeConfirmation(candidate.confirmationNumber || candidate.reservationId) ||
		normalizeConfirmation(candidate.hotelConfirmationNumber) ||
		normalizeWhitespace(candidate.sourceSnippet || "").slice(0, 120)
	}`;

const scoreReservationCandidate = (candidate = {}) => {
	const fields = [
		candidate.confirmationNumber,
		candidate.reservationId,
		candidate.guestName,
		candidate.checkinDate,
		candidate.checkoutDate,
		candidate.roomName,
		candidate.amount,
		candidate.amountHint,
		candidate.statusRaw,
		candidate.sourceUrl,
	].filter(Boolean).length;
	return fields * 10 + Math.min(String(candidate.sourceSnippet || "").length / 80, 12);
};

const mergeReservationCandidates = (...candidateGroups) => {
	const byKey = new Map();
	for (const group of candidateGroups) {
		for (const candidate of Array.isArray(group) ? group : []) {
			const key = reservationCandidateKey(candidate);
			const existing = byKey.get(key);
			if (!existing || scoreReservationCandidate(candidate) > scoreReservationCandidate(existing)) {
				byKey.set(key, candidate);
			}
		}
	}
	return Array.from(byKey.values());
};

const isDateInRange = (value = "", dateFrom = "", dateTo = "") => {
	const date = parseExpediaDate(value) || normalizeLine(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
	if (dateFrom && date < dateFrom) return false;
	if (dateTo && date > dateTo) return false;
	return true;
};

const filterCandidatesForJobRange = (candidates = [], job = {}) => {
	const dateFrom = normalizeLine(job.dateFrom || "");
	const dateTo = normalizeLine(job.dateTo || "");
	if (!dateFrom && !dateTo) return candidates;
	return candidates.filter((candidate) => {
		const dates = [
			candidate.checkinDate,
			candidate.checkoutDate,
			candidate.bookedAt,
		].filter(Boolean);
		if (!dates.length) return true;
		return dates.some((date) => isDateInRange(date, dateFrom, dateTo));
	});
};

const emptyBuckets = () => ({
	newReservations: [],
	skippedCancelled: [],
	matchedExisting: [],
	statusChanged: [],
	conflicts: [],
	needsReview: [],
	paymentOrVccAvailable: [],
});

const summarizeBuckets = (buckets = emptyBuckets()) => ({
	newReservations: buckets.newReservations.length,
	skippedCancelled: buckets.skippedCancelled.length,
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
	const statusToApply = normalizeLine(candidate.statusToApply || "").toLowerCase();
	if (!existing) {
		if (["cancelled", "no_show"].includes(statusToApply)) {
			return {
				bucket: "skippedCancelled",
				item: {
					...candidate,
					actionPreview: "missing_cancelled_reservation_skipped_no_write",
					skipReason:
						"Expedia reservation is cancelled/no-show and no PMS document exists.",
				},
			};
		}
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
	await captureAuditScreenshot({
		page,
		artifacts,
		fileName: `${prefix}-${job.jobNumber}.png`,
	});
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
		await captureAuditScreenshot({
			page,
			artifacts,
			fileName: `needs-mfa-${job.jobNumber}-attempt-${attempt}.png`,
		});
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

	let usernameTyped = false;
	try {
		usernameTyped = await withTimeout(
			typeIntoFirstVisibleInput(page, EMAIL_INPUT_SELECTORS, credentials.username),
			LOGIN_STEP_TIMEOUT_MS,
			"expedia_username_step_timeout"
		);
	} catch (error) {
		return {
			ok: false,
			status: "needs_login",
			message: `Expedia login timed out while entering the username (${error.message || error}). Try the collector again from the frontend.`,
		};
	}
	if (usernameTyped) {
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

	let passwordTyped = false;
	try {
		passwordTyped = await withTimeout(
			typeIntoFirstVisibleInput(page, PASSWORD_INPUT_SELECTORS, credentials.password),
			LOGIN_STEP_TIMEOUT_MS,
			"expedia_password_step_timeout"
		);
	} catch (error) {
		return {
			ok: false,
			status: "needs_login",
			message: `Expedia login timed out while entering the password (${error.message || error}). Try the collector again from the frontend.`,
		};
	}
	if (passwordTyped) {
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

	page = await gotoCollectorPage({
		browser: page.browser(),
		page,
		url: process.env.OTA_EXPEDIA_MANAGE_PROPERTY_URL || DEFAULT_MANAGE_PROPERTY_URL,
	}).catch(() => page);
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
	let collectorTimedOut = false;
	const buckets = emptyBuckets();
	const artifacts = {
		outputDir: collectorOutputDir(),
		screenshots: [],
		propertyCount: 0,
		matchedPropertyCount: 0,
		selectedHotelCount: selectedHotelIds.length,
	};
	const hardTimeoutTimer = setTimeout(() => {
		collectorTimedOut = true;
		updateJob(jobId, {
			$set: {
				status: "collector_failed",
				previewBuckets: buckets,
				collectorArtifacts: artifacts,
				resultSummary: summarizeBuckets(buckets),
				collectorState: {
					status: "collector_failed",
					startedAt: new Date(startedAt),
					finishedAt: new Date(),
					durationMs: Date.now() - startedAt,
					readOnly: true,
					error: "collector_hard_timeout",
					message:
						"Expedia collector exceeded the hard browser timeout and was stopped. Run it again from the frontend.",
				},
			},
			$push: {
				auditLog: {
					at: new Date(),
					action: "collector_hard_timeout",
					by: actorId,
					readOnly: true,
					timeoutMs: COLLECTOR_HARD_TIMEOUT_MS,
				},
			},
		}).catch(() => {});
		if (browser) {
			browser.close().catch(() => {});
		}
	}, COLLECTOR_HARD_TIMEOUT_MS);
	if (typeof hardTimeoutTimer.unref === "function") hardTimeoutTimer.unref();

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
		let page = await createCollectorPage(browser, { closeExisting: true });
		const managePropertyUrl =
			process.env.OTA_EXPEDIA_MANAGE_PROPERTY_URL ||
			DEFAULT_MANAGE_PROPERTY_URL;
		const openLoggedInPropertyPage = async (currentPage) => {
			let workingPage = await gotoCollectorPage({
				browser,
				page: currentPage,
				url: managePropertyUrl,
				retries: 3,
			});
			await delay(1500);

			let workingSnapshot = await stablePageSnapshot(workingPage);
			if (isLoginOrVerificationPage(workingSnapshot)) {
				const loginResult = await attemptExpediaLogin({
					jobId,
					job,
					page: workingPage,
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
						page: workingPage,
					});
					await appendAudit(jobId, {
						action: loginResult.status || "collector_needs_login",
						by: actorId,
						readOnly: true,
					});
					return { blocked: true, page: workingPage, snapshot: workingSnapshot };
				}
				workingPage = loginResult.page || workingPage;
				await Promise.race([
					workingPage
						.waitForNavigation({
							waitUntil: "domcontentloaded",
							timeout: 5000,
						})
						.catch(() => null),
					delay(1800),
				]);
				workingSnapshot = await stablePageSnapshot(workingPage);
			}

			if (!hasPropertyListText(workingSnapshot.text)) {
				workingPage = await gotoCollectorPage({
					browser,
					page: workingPage,
					url: managePropertyUrl,
					retries: 3,
				});
				await delay(1500);
				workingSnapshot = await stablePageSnapshot(workingPage);
			}

			if (!hasPropertyListText(workingSnapshot.text)) {
				const propertyPage = await findPageByContent(
					browser,
					(pageSnapshot) => hasPropertyListText(pageSnapshot.text),
					Math.min(20_000, MAX_RUN_MS)
				);
				await propertyPage.bringToFront().catch(() => {});
				workingPage = propertyPage;
				workingSnapshot = await stablePageSnapshot(workingPage);
			}

			return { page: workingPage, snapshot: workingSnapshot };
		};

		let propertyPageResult = null;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			try {
				propertyPageResult = await openLoggedInPropertyPage(page);
				break;
			} catch (error) {
				if (!isRecoverablePageLifecycleError(error) || attempt >= 2) {
					throw error;
				}
				await appendAudit(jobId, {
					action: "collector_recoverable_property_discovery_retry",
					by: actorId,
					readOnly: true,
					attempt: attempt + 1,
					error: error && error.message ? error.message : String(error),
				});
				if (page?.close) {
					await page.close({ runBeforeUnload: false }).catch(() => {});
				}
				await delay(600 + attempt * 350);
				page = await createCollectorPage(browser, { closeExisting: true });
			}
		}
		if (propertyPageResult?.blocked) return;
		page = propertyPageResult?.page || page;

		await scrollToLoadVisibleContent(page).catch(() => {});
		let properties = await extractProperties(page);
		if (!properties.length) {
			const propertyPage = await findPageByContent(
				browser,
				(pageSnapshot) => hasPropertyListText(pageSnapshot.text),
				10_000
			);
			await propertyPage.bringToFront().catch(() => {});
			await scrollToLoadVisibleContent(propertyPage).catch(() => {});
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
			let candidates = await extractReservationCandidates(
				page,
				hotel,
				match.property
			);
			const defaultBookingsUrl = buildExpediaBookingsUrl(
				match.property.expediaPropertyId
			);
			const defaultBookingsPass = await gotoCollectorPage({
				browser,
				page,
				url: defaultBookingsUrl,
			})
				.then(async (defaultPage) => {
					page = defaultPage;
					await waitForReservationsSurface(page);
					await scrollToLoadVisibleContent(page).catch(() => {});
					const defaultCandidates = filterCandidatesForJobRange(
						await extractReservationCandidates(page, hotel, match.property).catch(
							() => []
						),
						job
					);
					candidates = mergeReservationCandidates(candidates, defaultCandidates);
					return {
						opened: true,
						method: "default_next_reservations",
						href: defaultBookingsUrl,
						candidateCount: defaultCandidates.length,
					};
				})
				.catch((error) => ({
					opened: false,
					method: "default_next_reservations_error",
					href: defaultBookingsUrl,
					error: error && error.message ? error.message : String(error),
				}));
			reservationNavigation.defaultBookingsPass = defaultBookingsPass;
			const recentBookedRange = recentBookedDateRangeForJob(job);
			if (recentBookedRange) {
				const recentBookedDateFilter = await applyBookingsDateFilter(page, {
					...recentBookedRange,
					dateMode: "booked_on",
				}).catch((error) => ({
					applied: false,
					dateMode: "booked_on",
					error: error && error.message ? error.message : String(error),
				}));
				if (recentBookedDateFilter.applied) {
					await scrollToLoadVisibleContent(page).catch(() => {});
					const recentBookedCandidates = await extractReservationCandidates(
						page,
						hotel,
						match.property
					).catch(() => []);
					candidates = mergeReservationCandidates(
						candidates,
						recentBookedCandidates
					);
				}
				reservationNavigation.recentBookedDateFilter = recentBookedDateFilter;
			}
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
			let detailPagesFetched = 0;
			for (const rowCandidate of candidates) {
				let candidate = rowCandidate;
				let classification = await classifyCandidate(candidate);
				const shouldFetchDetails =
					classification.bucket === "newReservations" ||
					classification.bucket === "statusChanged";
				if (shouldFetchDetails) {
					if (detailPagesFetched >= MAX_DETAIL_PAGES_PER_HOTEL) {
						candidate = normalizeCandidateMoneyToSar({
							...candidate,
							detailsFetched: false,
							detailsSkippedReason: "detail_page_cap_reached",
						});
						classification = await classifyCandidate(candidate);
					} else {
						detailPagesFetched += 1;
						try {
							candidate = await enrichCandidateFromDetailPage(page, candidate);
						} catch (error) {
							candidate = normalizeCandidateMoneyToSar({
								...candidate,
								detailsFetched: false,
								detailsError:
									error && error.message ? error.message : String(error),
							});
						}
						classification = await classifyCandidate(candidate);
					}
				} else {
					candidate = normalizeCandidateMoneyToSar({
						...candidate,
						detailsFetched: false,
						detailsSkippedReason: "matched_existing_no_write_fast_path",
					});
					classification = {
						...classification,
						item: {
							...classification.item,
							...candidate,
							actionPreview: classification.item?.actionPreview,
							reservationId: classification.item?.reservationId,
							pmsConfirmationNumber:
								classification.item?.pmsConfirmationNumber || "",
							currentStatus: classification.item?.currentStatus || "",
							incomingStatus: classification.item?.incomingStatus || "",
							matchedLookupValue:
								classification.item?.matchedLookupValue || "",
							matchedReservationBy:
								classification.item?.matchedReservationBy || [],
						},
					};
				}
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
						sourceCurrency:
							candidate.sourceCurrency ||
							candidate.paymentSummary?.sourceCurrency ||
							"",
						sourceAmount:
							candidate.sourceAmount ||
							candidate.paymentSummary?.sourceTotalGuestPaymentAmount ||
							0,
						exchangeRateToSar:
							candidate.exchangeRateToSar ||
							candidate.paymentSummary?.exchangeRateToSar ||
							0,
						exchangeRateSource:
							candidate.exchangeRateSource ||
							candidate.paymentSummary?.exchangeRateSource ||
							"",
						totalGuestPaymentAmount:
							candidate.paymentSummary?.totalGuestPaymentAmount ||
							candidate.amount ||
							0,
						sourceTotalGuestPaymentAmount:
							candidate.paymentSummary?.sourceTotalGuestPaymentAmount ||
							candidate.sourceAmount ||
							0,
						totalPayoutAmount: candidate.paymentSummary?.totalPayoutAmount || 0,
						sourceTotalPayoutAmount:
							candidate.paymentSummary?.sourceTotalPayoutAmount || 0,
						hasVirtualCardSignal:
							candidate.paymentSignals?.hasVirtualCardSignal || false,
						rawCardStored: false,
						actionPreview: "payment_signal_no_card_data_stored",
					});
				}
				buckets[classification.bucket].push(classification.item);
			}

			await updateJob(jobId, {
				$set: {
					previewBuckets: buckets,
					collectorArtifacts: artifacts,
					resultSummary: summarizeBuckets(buckets),
				},
			});

			page = await gotoCollectorPage({
				browser,
				page,
				url: managePropertyUrl,
			}).catch(() => page);
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
		if (collectorTimedOut) return;
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
		clearTimeout(hardTimeoutTimer);
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
