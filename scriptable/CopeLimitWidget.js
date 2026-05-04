// CopeLimit Scriptable widget for iOS.
// Paste into Scriptable and set COPELIMIT_URL to your deployed usage endpoint.

const COPELIMIT_URL = "https://your-site.netlify.app/.netlify/functions/usage";

async function getUsage() {
  const request = new Request(COPELIMIT_URL);
  request.headers = { "accept": "application/json" };
  return await request.loadJSON();
}

function colourFor(level) {
  if (level === "over" || level === "hot") return new Color("#ef4444");
  if (level === "warm") return new Color("#f59e0b");
  return new Color("#60a5fa");
}

function addLine(widget, left, right, muted = false) {
  const row = widget.addStack();
  row.layoutHorizontally();

  const l = row.addText(left);
  l.font = Font.mediumSystemFont(11);
  l.textColor = muted ? Color.gray() : Color.white();

  row.addSpacer();

  const r = row.addText(right);
  r.font = Font.semiboldSystemFont(11);
  r.textColor = muted ? Color.gray() : Color.white();
}

const usage = await getUsage();

const widget = new ListWidget();
widget.backgroundColor = new Color("#111827");
widget.setPadding(14, 14, 14, 14);

const title = widget.addText("CopeLimit");
title.font = Font.boldSystemFont(16);
title.textColor = Color.white();

widget.addSpacer(6);

const remaining = widget.addText(String(usage.remaining));
remaining.font = Font.heavySystemFont(42);
remaining.textColor = colourFor(usage.warningLevel);
remaining.minimumScaleFactor = 0.6;

const caption = widget.addText(`remaining of ${usage.quota}`);
caption.font = Font.mediumSystemFont(12);
caption.textColor = Color.gray();

widget.addSpacer(10);

addLine(widget, "Used", `${usage.used} (${usage.percentUsed}%)`);
addLine(widget, "Reset", new Date(usage.resetAt).toLocaleDateString());
addLine(widget, "Source", usage.source, true);

Script.setWidget(widget);
Script.complete();
