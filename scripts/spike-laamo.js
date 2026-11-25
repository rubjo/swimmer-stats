/**
 * Spike for the LÅMØ / ÅM scraper (svom-app/docs/plans/laamo-am.md, task 1).
 *
 * Found so far (run 2):
 *   cmbLandsdel  0 = Vis uavhengig av landsdel, 6 Nord, 7 Midt, 8 Vest 1,
 *                9 Vest 2, 10 Sør, 11 Øst 1, 12 Øst 2
 *   cmbKlasse    0 = alle, 137–141 = 2015–2011, 143–147 = 2015–2011 Para
 *   cmbKlubb     depends on the district
 *   rbDamer / rbHerrer, rbTid / rbPoeng; export menu mnuEksport
 *                (DXI0 xlsx, DXI1 rtf, DXI2 csv, DXI3 pdf)
 * A fresh session opens on Nord / 2015 - Para / Damer. Clicking the
 * DevExpress list items did nothing, so this run sets values through the
 * DevExpress client API and fires their change events, then:
 *   1. prints every DevExpress control and the combos' change handlers,
 *   2. logs each POST a change sends (and the response size),
 *   3. tries the CSV export and prints its start,
 *   4. counts the rows. Expect Åsmund Faag (Sandnes SLK, 3060 p) first
 *      nationally for 2011 boys.
 *
 *   node scripts/spike-laamo.js [slid]   (default 17 = LÅMØ 2027)
 */
import puppeteer from "puppeteer";

const slid = process.argv[2] || "17";

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setExtraHTTPHeaders({ "Accept-Language": "nb-NO,nb;q=0.9" });

const requests = [];
page.on("request", (req) => {
  if (req.method() !== "POST" || !req.url().includes("medley.no/sl")) return;
  const fields = {};
  for (const [k, v] of new URLSearchParams(req.postData() || "")) {
    fields[k] =
      /^__VIEWSTATE|^__EVENTVALIDATION|^DX/.test(k) || v.length > 300
        ? `<${v.length} chars>`
        : v;
  }
  requests.push({ url: req.url(), fields });
});
page.on("response", async (res) => {
  if (res.request().method() !== "POST" || !res.url().includes("medley.no/sl")) return;
  const r = requests.find((q) => q.url === res.url() && !q.status);
  if (!r) return;
  r.status = res.status();
  r.contentType = res.headers()["content-type"];
  r.disposition = res.headers()["content-disposition"];
  const body = await res.text().catch(() => "");
  r.bytes = body.length;
  r.start = body.slice(0, 600);
});

await page.goto(`https://www.medley.no/sl.aspx?slid=${slid}`, {
  waitUntil: "networkidle2",
  timeout: 60_000,
});

const controls = await page.evaluate(() => {
  const coll = window.ASPxClientControl?.GetControlCollection?.();
  const out = [];
  coll?.ForEachControl?.((c) => {
    const handlers = (ev) =>
      (c[ev]?.handlerInfoList || []).map((h) => String(h.handler).slice(0, 400));
    out.push({
      name: c.name,
      type: c.constructor?.name,
      autoPostBack: c.autoPostBack,
      ValueChanged: handlers("ValueChanged"),
      SelectedIndexChanged: handlers("SelectedIndexChanged"),
      CheckedChanged: handlers("CheckedChanged"),
      ItemClick: handlers("ItemClick"),
    });
  });
  return out;
});
console.log("DevExpress controls:");
console.log(JSON.stringify(controls, null, 2));

const settle = () =>
  page.waitForNetworkIdle({ idleTime: 1000, timeout: 30_000 }).catch(() => {});

/** Set a combo's value and fire its change, as the dropdown would. */
async function setCombo(name, value) {
  const before = requests.length;
  const how = await page.evaluate(
    (name, value) => {
      const c = ASPxClientControl.GetControlCollection().GetByName(name);
      const i = [...Array(c.GetItemCount()).keys()].find(
        (i) => String(c.GetItem(i).value) === String(value),
      );
      c.SetSelectedIndex(i);
      if (typeof c.RaiseValueChangedEvent === "function") {
        c.RaiseValueChangedEvent();
        return "RaiseValueChangedEvent";
      }
      c.SelectedIndexChanged?.FireEvent(c, {});
      c.ValueChanged?.FireEvent(c, {});
      return "FireEvent";
    },
    name,
    value,
  );
  await settle();
  console.log(`\n${name} = ${value} via ${how}: ${requests.length - before} request(s)`);
}

async function setRadio(name) {
  const before = requests.length;
  const how = await page.evaluate((name) => {
    const c = ASPxClientControl.GetControlCollection().GetByName(name);
    c.SetChecked(true);
    if (typeof c.RaiseValueChangedEvent === "function") {
      c.RaiseValueChangedEvent();
      return "RaiseValueChangedEvent";
    }
    c.CheckedChanged?.FireEvent(c, {});
    return "FireEvent";
  }, name);
  await settle();
  console.log(`\n${name} via ${how}: ${requests.length - before} request(s)`);
}

await setCombo("cmbLandsdel", 0);
await setCombo("cmbKlasse", 141);
await setRadio("rbHerrer");

const table = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("tr")]
    .filter((tr) => tr.querySelector('a[href*="svommer.aspx?id="]'))
    .map((tr) => [...tr.cells].map((td) => td.innerText.trim()));
  const header = [...document.querySelectorAll("tr")]
    .map((tr) => [...tr.cells].map((td) => td.innerText.trim()))
    .find((c) => c.includes("Navn") && c.includes("Poeng"));
  const klasse = document.getElementById("cmbKlasse_I")?.value;
  const landsdel = document.getElementById("cmbLandsdel_I")?.value;
  return { landsdel, klasse, header, count: rows.length, first: rows.slice(0, 5) };
});
console.log(`\nnow showing: ${table.landsdel} / ${table.klasse}`);
console.log(`header: ${JSON.stringify(table.header)}`);
console.log(`rows: ${table.count}`);
console.table(table.first);

// The CSV export: a menu item, probably a full postback that answers with
// the file. Its response is logged below with its content type.
const beforeCsv = requests.length;
await page.click("#mnuEksport_DXI2_T").catch((e) => console.log("csv click:", e.message));
await settle();
console.log(`\nCSV export: ${requests.length - beforeCsv} request(s)`);

console.log("\nPOST requests (fields, status, type, size, start of body):");
console.log(JSON.stringify(requests, null, 2));

await browser.close();
