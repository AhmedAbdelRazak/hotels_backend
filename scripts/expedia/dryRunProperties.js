const fs = require("fs");
const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer");

const DEFAULT_LOGIN_URL =
	"https://expediapartnercentral.com/Account/Logon?returnUrl=https%3A%2F%2Fapps.expediapartnercentral.com%2Fmanageproperty%2FManageProperty";
const MANAGE_PROPERTY_URL =
	"https://apps.expediapartnercentral.com/manageproperty/ManageProperty";

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir =
	process.env.EXPEDIA_DRY_RUN_OUTPUT_DIR ||
	path.join(process.cwd(), "audits", "expedia-dry-run");
const profileDir =
	process.env.EXPEDIA_DRY_RUN_PROFILE_DIR ||
	path.join(os.homedir(), ".jannatbooking", "expedia-dry-run-profile");
const timeoutMinutes = Number(process.env.EXPEDIA_DRY_RUN_TIMEOUT_MINUTES || 15);
const keepOpen = /^(1|true|yes)$/i.test(
	process.env.EXPEDIA_DRY_RUN_KEEP_OPEN || ""
);
const noSandbox = /^(1|true|yes)$/i.test(
	process.env.EXPEDIA_BROWSER_NO_SANDBOX || ""
);

function normalizeLine(value) {
	return String(value || "").replace(/\s+/g, " ").trim();
}

function isLikelyPropertyName(value) {
	const line = normalizeLine(value);
	if (!line || line.length < 3) return false;
	if (/^(home|search|your properties|property id|terms of use)$/i.test(line)) {
		return false;
	}
	return true;
}

function parsePropertiesFromText(rawText) {
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

	for (let i = 0; i < lines.length - 1; i += 1) {
		const name = lines[i];
		const idMatch = lines[i + 1].match(/^Property ID\s+([A-Za-z0-9-]+)/i);
		if (!idMatch || !isLikelyPropertyName(name)) continue;

		const expediaPropertyId = idMatch[1];
		const addressLines = [];
		for (let j = i + 2; j < Math.min(lines.length, i + 7); j += 1) {
			if (/^Property ID\s+/i.test(lines[j])) break;
			if (lines[j + 1] && /^Property ID\s+/i.test(lines[j + 1])) break;
			addressLines.push(lines[j]);
		}

		const key = `${expediaPropertyId}:${name.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		properties.push({
			name,
			expediaPropertyId,
			address: addressLines.join(", "),
		});
	}

	return properties;
}

async function scrollToLoadVisibleProperties(page) {
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
				if (stableRounds >= 5) {
					clearInterval(interval);
					window.scrollTo(0, 0);
					resolve();
				}
			}, 250);
		});
	});
}

async function extractProperties(page) {
	const snapshot = await page.evaluate(() => {
		const links = Array.from(document.querySelectorAll("a"))
			.map((link) => ({
				text: (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim(),
				href: link.href || "",
			}))
			.filter((link) => link.text && link.href);

		return {
			text: document.body.innerText || "",
			links,
		};
	});

	const parsed = parsePropertiesFromText(snapshot.text);
	return parsed.map((property) => {
		const match = snapshot.links.find(
			(link) => link.text.toLowerCase() === property.name.toLowerCase()
		);
		return {
			...property,
			url: match ? match.href : "",
		};
	});
}

function ensureDirectory(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function runSelfTest() {
	const sample = `
Home
Portfolio Performance
Manage a property
Search
Your Properties
Al-Magd Hotel
Property ID 120233712
4481 Al Masjid Al Haram Road
Makkah SAU 24236
AlSukareya HOTEL
Property ID 120199112
No 7111 Street 84 Ajyad Al Masafi
Makkah, Makkah Province 0000 SAU
Zad Al Safa Hotel
Property ID 122352868
Al Balad Al Amine St, Behind Om Al Qora University
Makkah, Makkah Province 24243 SAU
`;
	const properties = parsePropertiesFromText(sample);
	if (properties.length !== 3) {
		throw new Error(`Expected 3 properties in self-test, got ${properties.length}`);
	}
	if (!properties.some((property) => property.name === "AlSukareya HOTEL")) {
		throw new Error("Self-test did not parse AlSukareya HOTEL");
	}
	console.log(JSON.stringify({ ok: true, properties }, null, 2));
}

async function main() {
	if (process.argv.includes("--self-test")) {
		runSelfTest();
		return;
	}

	ensureDirectory(outputDir);
	ensureDirectory(profileDir);

	const launchArgs = ["--window-size=1440,950"];
	if (noSandbox) {
		launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
	}

	const launchOptions = {
		headless: false,
		userDataDir: profileDir,
		defaultViewport: null,
		args: launchArgs,
	};

	if (process.env.EXPEDIA_BROWSER_PATH) {
		launchOptions.executablePath = process.env.EXPEDIA_BROWSER_PATH;
	}

	console.log("Expedia dry-run property collector");
	console.log("No Expedia password is read, stored, or submitted by this script.");
	console.log(`Profile dir: ${profileDir}`);
	console.log(`Output dir: ${outputDir}`);
	console.log(
		`Opening Partner Central. Please complete login and MFA manually within ${timeoutMinutes} minutes.`
	);

	const browser = await puppeteer.launch(launchOptions);
	const page = await browser.newPage();
	page.setDefaultTimeout(timeoutMinutes * 60 * 1000);
	await page.goto(process.env.EXPEDIA_DRY_RUN_LOGIN_URL || DEFAULT_LOGIN_URL, {
		waitUntil: "domcontentloaded",
	});

	await page.waitForFunction(
		() =>
			/apps\.expediapartnercentral\.com/i.test(window.location.href) ||
			/manageproperty/i.test(window.location.href) ||
			/Your Properties|Manage a property|Select a property/i.test(
				document.body.innerText || ""
			),
		{ timeout: timeoutMinutes * 60 * 1000 }
	);

	await page.goto(MANAGE_PROPERTY_URL, { waitUntil: "domcontentloaded" });
	await page.waitForFunction(
		() => /Your Properties|Property ID|Manage a property/i.test(document.body.innerText || ""),
		{ timeout: 90 * 1000 }
	);
	await scrollToLoadVisibleProperties(page);

	const properties = await extractProperties(page);
	const screenshotPath = path.join(outputDir, `properties-${timestamp}.png`);
	const jsonPath = path.join(outputDir, `properties-${timestamp}.json`);
	const result = {
		dryRun: true,
		action: "expedia_property_list_read_only",
		extractedAt: new Date().toISOString(),
		currentUrl: page.url(),
		propertyCount: properties.length,
		properties,
		screenshotPath,
	};

	await page.screenshot({ path: screenshotPath, fullPage: true });
	fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));

	console.log(JSON.stringify(result, null, 2));
	console.log(`Saved JSON: ${jsonPath}`);
	console.log(`Saved screenshot: ${screenshotPath}`);

	if (keepOpen) {
		console.log("Keeping browser open because EXPEDIA_DRY_RUN_KEEP_OPEN is enabled.");
		return;
	}
	await browser.close();
}

main().catch((error) => {
	console.error("Expedia dry-run failed.");
	console.error(error && error.stack ? error.stack : error);
	process.exitCode = 1;
});
