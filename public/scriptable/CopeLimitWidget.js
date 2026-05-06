// CopeLimit Scriptable widget for iOS.
// Token is configured automatically via the CopeLimit PWA onboarding flow.
// Do not use your GitHub token here.

const COPELIMIT_URL = "https://copelimit.netlify.app/api/widget-usage";
const WIDGET_TOKEN = Keychain.get("copelimit_widget_token") || "";

async function getUsage() {
  const request = new Request(COPELIMIT_URL);
  request.headers = {
    accept: "application/json",
    authorization: `Bearer ${WIDGET_TOKEN}`
  };

  const response = await request.loadJSON();

  if (response.error) {
    throw new Error(response.error);
  }

  return response;
}

function colourFor(usage) {
  if (usage.source === "unsupported") return new Color("#f59e0b");
  if (usage.warningLevel === "over" || usage.warningLevel === "hot") return new Color("#ef4444");
  if (usage.warningLevel === "warm") return new Color("#f59e0b");
  if (usage.source === "github-copilot-internal") return new Color("#22c55e");
  if (usage.source === "copilot-local") return new Color("#60a5fa");
  return new Color("#60a5fa");
}

function sourceLabel(source) {
  if (source === "github-copilot-internal") return "live";
  if (source === "copilot-local") return "local";
  if (source === "mock") return "mock";
  if (source === "unsupported") return "unsupported";
  return source || "unknown";
}

function formatDate(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleDateString("en-GB");
}

function addLine(widget, left, right, muted = false) {
  const row = widget.addStack();
  row.layoutHorizontally();

  const l = row.addText(left);
  l.font = Font.mediumSystemFont(11);
  l.textColor = muted ? Color.gray() : Color.white();

  row.addSpacer();

  const r = row.addText(String(right));
  r.font = Font.semiboldSystemFont(11);
  r.textColor = muted ? Color.gray() : Color.white();
  r.minimumScaleFactor = 0.65;
  r.lineLimit = 1;
}

let usage;

try {
  usage = await getUsage();
} catch (error) {
  usage = {
    remaining: "?",
    quota: "?",
    used: "?",
    percentUsed: "?",
    resetAt: null,
    source: "error",
    warningLevel: "hot",
    error: error instanceof Error ? error.message : "Unknown error"
  };
}

const widget = new ListWidget();
widget.backgroundColor = new Color("#111827");
widget.setPadding(14, 14, 14, 14);
widget.url = "https://copelimit.netlify.app";

const title = widget.addText("CopeLimit");
title.font = Font.boldSystemFont(16);
title.textColor = Color.white();

widget.addSpacer(6);

const remaining = widget.addText(String(usage.remaining));
remaining.font = Font.heavySystemFont(42);
remaining.textColor = colourFor(usage);
remaining.minimumScaleFactor = 0.55;
remaining.lineLimit = 1;

const caption = widget.addText(`remaining of ${usage.quota}`);
caption.font = Font.mediumSystemFont(12);
caption.textColor = Color.gray();
caption.minimumScaleFactor = 0.7;
caption.lineLimit = 1;

widget.addSpacer(10);

if (usage.error) {
  addLine(widget, "Error", usage.error, false);
} else {
  addLine(widget, "Used", `${usage.used} (${usage.percentUsed}%)`);
  addLine(widget, "Reset", formatDate(usage.resetAt));
  addLine(widget, "Source", sourceLabel(usage.source), true);
}

Script.setWidget(widget);
Script.complete();
