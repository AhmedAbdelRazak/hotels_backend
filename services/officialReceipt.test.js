const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildOfficialReceiptView,
  countryCodeFromNationality,
  displayNationality,
  renderOfficialReceiptHtml,
} = require("./officialReceipt");

test("official receipt resolves current and legacy nationality formats", () => {
  assert.equal(countryCodeFromNationality("EG"), "eg");
  assert.equal(countryCodeFromNationality("Egypt"), "eg");
  assert.equal(countryCodeFromNationality("Egyptian"), "eg");
  assert.equal(countryCodeFromNationality("مصري"), "eg");
  assert.equal(displayNationality("EG", "eg"), "Egyptian");
});

test("official receipt groups 20 identical agency rooms", () => {
  const pickedRoomsType = Array.from({ length: 20 }, () => ({
    room_type: "quadrupleRooms",
    displayName: "Quadruple Room",
    count: 1,
    chosenPrice: 75,
    pricingByDay: [{ price: 75 }, { price: 80 }],
  }));
  const view = buildOfficialReceiptView(
    {
      confirmation_number: "1234567890",
      checkin_date: "2026-07-14",
      checkout_date: "2026-07-16",
      pickedRoomsType,
      total_amount: 3100,
      paid_amount: 1550,
      customer_details: { name: "Agency Guest", nationality: "EG" },
    },
    { hotelName: "Zad Ajyad" }
  );
  assert.equal(view.rooms.length, 1);
  assert.equal(view.rooms[0].count, 20);
  assert.equal(view.rooms[0].total, 3100);
  assert.equal(view.payment.remaining, 1550);
});

test("official receipt escapes customer-controlled HTML and embeds a local flag", () => {
  const html = renderOfficialReceiptHtml(
    {
      confirmation_number: "ABC123",
      checkin_date: "2026-07-14",
      checkout_date: "2026-07-16",
      customer_details: {
        name: "<script>alert(1)</script>",
        nationality: "EG",
      },
    },
    { hotelName: "Zad Ajyad" }
  );
  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.equal(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), true);
  assert.equal(html.includes("data:image/svg+xml;base64,"), true);
});

test("official receipt print layout never exceeds the A4 page width", () => {
  const html = renderOfficialReceiptHtml(
    {
      confirmation_number: "PDF-WIDTH-CHECK",
      checkin_date: "2026-07-26",
      checkout_date: "2026-08-03",
      pickedRoomsType: [
        {
          room_type: "tripleRooms",
          displayName: "Triple Room - Premium Comfort",
          count: 1,
          chosenPrice: 70,
        },
      ],
      customer_details: {
        name: "Mohamed Adel Fathy Hussein",
        nationality: "EG",
      },
    },
    { hotelName: "Zad Ajyad" }
  );

  assert.match(
    html,
    /@media print\s*\{\s*\.receipt\s*\{\s*max-width:none;\s*width:100%;\s*\}/
  );
  assert.match(
    html,
    /\.payment-method,\.receipt-footer\s*\{\s*break-inside:avoid;/
  );
  assert.match(
    html,
    /\.confirmation-number\s*\{[^}]*overflow-wrap:anywhere;/
  );
  assert.doesNotMatch(html, /width:\s*111\.112%/);
  assert.doesNotMatch(html, /zoom:\s*\.9/);
});

test(
  "representative official receipt renders as one complete A4 page",
  { timeout: 30000 },
  async () => {
    const puppeteer = require("puppeteer");
    const html = renderOfficialReceiptHtml(
      {
        confirmation_number: "7163348135",
        checkin_date: "2026-07-26",
        checkout_date: "2026-08-03",
        total_amount: 560,
        paid_amount: 0,
        customer_details: {
          name: "Production Layout Check",
          nationality: "EG",
        },
        pickedRoomsType: [
          {
            room_type: "tripleRooms",
            displayName: "Triple Room - Premium Comfort",
            count: 1,
            chosenPrice: 70,
            pricingByDay: Array.from({ length: 8 }, () => ({ price: 70 })),
          },
        ],
      },
      { hotelName: "Zad Ajyad" }
    );
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 794, height: 1123 });
      await page.emulateMediaType("print");
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const layout = await page.evaluate(() => {
        const receipt = document.querySelector(".receipt");
        const bounds = receipt.getBoundingClientRect();
        return {
          documentWidth: document.documentElement.scrollWidth,
          receiptHeight: bounds.height,
          receiptRight: bounds.right,
          viewportWidth: document.documentElement.clientWidth,
        };
      });
      const pdf = await page.pdf({ format: "A4", printBackground: true });
      const pageCount = (
        pdf.toString("latin1").match(/\/Type\s*\/Page\b/g) || []
      ).length;

      assert.equal(layout.documentWidth, layout.viewportWidth);
      assert.ok(layout.receiptRight <= layout.viewportWidth);
      assert.ok(layout.receiptHeight <= 1123);
      assert.equal(pageCount, 1);
      await page.close();
    } finally {
      await browser.close();
    }
  }
);
