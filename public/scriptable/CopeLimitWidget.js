// CopeLimit Scriptable widget for iOS.
// Supports small, medium, and large widget families.
// Token is configured automatically via the CopeLimit PWA onboarding flow.
// Do not use your GitHub token here.

const BASE_URL = "https://copelimit.netlify.app/api/widget-usage";
const APP_URL = "https://copelimit.netlify.app";
const WIDGET_TOKEN = Keychain.get("copelimit_widget_token") || "";

// --- API -------------------------------------------------------------------

async function getUsage(includeExtras) {
  const url = includeExtras ? `${BASE_URL}?extras=1` : BASE_URL;
  const request = new Request(url);
  request.headers = {
    accept: "application/json",
    authorization: `Bearer ${WIDGET_TOKEN}`
  };
  const response = await request.loadJSON();
  if (response.error) throw new Error(response.error);
  return response;
}

// --- Pure helpers (no Scriptable globals) ----------------------------------

function colourHexFor(usage) {
  if (usage.source === "unsupported") return "#f59e0b";
  if (usage.billingPhase === "budget_active") return "#ef4444";
  if (usage.warningLevel === "over" || usage.warningLevel === "hot") return "#ef4444";
  if (usage.warningLevel === "warm") return "#f59e0b";
  if (usage.source === "github-copilot-internal") return "#22c55e";
  return "#60a5fa";
}

function sourceLabel(source) {
  if (source === "github-copilot-internal") return "live";
  if (source === "copilot-local") return "local";
  if (source === "mock") return "mock";
  if (source === "unsupported") return "?";
  return source || "unknown";
}

function billingPhaseLabel(phase) {
  const labels = {
    credits_available: "Credits available",
    credits_exhausted: "Credits exhausted",
    budget_available: "Budget available",
    budget_active: "Budget in use",
    unlimited: "Unlimited",
    hard_stop: "Hard stop"
  };
  return labels[phase] || phase || "—";
}

function formatShortDate(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatNumber(n) {
  if (n === undefined || n === null || n === "?") return "?";
  return Number(n).toLocaleString("en");
}

function formatBurnRate(creditsPerHour) {
  if (creditsPerHour === null || creditsPerHour === undefined) return null;
  if (creditsPerHour === 0) return "0/hr";
  return `${creditsPerHour.toFixed(1)}/hr`;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toFixed(2)}`;
}

/**
 * Estimates hours until budget or included credits are exhausted.
 * Returns null when the burn rate is unknown or zero.
 */
function computeEtaHours(usage, burnRate) {
  if (!burnRate || burnRate <= 0) return null;
  if (usage.billingPhase === "budget_active") {
    const overageUsed = usage.overageCount ?? usage.derivedOverageCredits ?? 0;
    const overageCap = usage.overageEntitlement;
    if (overageCap === undefined || overageCap === null || overageCap <= 0) return null;
    const overageRemaining = Math.max(0, overageCap - overageUsed);
    return overageRemaining / burnRate;
  }
  if (usage.remaining > 0) return usage.remaining / burnRate;
  return 0;
}

function formatEta(etaHours) {
  if (etaHours === null || etaHours === undefined) return null;
  if (etaHours <= 0) return "Exhausted";
  if (etaHours < 1) return `~${Math.round(etaHours * 60)}m`;
  if (etaHours < 24) return `~${etaHours.toFixed(1)}hr`;
  return `~${(etaHours / 24).toFixed(1)}d`;
}

// --- Scriptable layout helpers --------------------------------------------

function makeBaseWidget(padding) {
  const w = new ListWidget();
  w.backgroundColor = new Color("#111827");
  w.setPadding(padding, padding, padding, padding);
  w.url = APP_URL;
  return w;
}

/**
 * Adds a key/value row to a container.
 * opts: { fontSize, muted, valueColor }
 */
function addMetricRow(container, label, value, opts) {
  const o = opts || {};
  const row = container.addStack();
  row.layoutHorizontally();
  const fs = o.fontSize || 11;

  const l = row.addText(String(label));
  l.font = Font.mediumSystemFont(fs);
  l.textColor = o.muted ? Color.gray() : Color.white();

  row.addSpacer();

  const r = row.addText(String(value));
  r.font = Font.semiboldSystemFont(fs);
  r.textColor = o.valueColor || (o.muted ? Color.gray() : Color.white());
  r.minimumScaleFactor = 0.65;
  r.lineLimit = 1;
}

/**
 * Adds a two-column metric row for the large widget grid.
 * opts: { fontSize, leftColor, rightColor }
 */
function addTwoColRow(container, lLabel, lValue, rLabel, rValue, opts) {
  const o = opts || {};
  const row = container.addStack();
  row.layoutHorizontally();
  const fs = o.fontSize || 12;

  const ll = row.addText(String(lLabel));
  ll.font = Font.mediumSystemFont(fs);
  ll.textColor = Color.gray();
  row.addSpacer(5);

  const lv = row.addText(String(lValue));
  lv.font = Font.semiboldSystemFont(fs);
  lv.textColor = o.leftColor || Color.white();
  lv.minimumScaleFactor = 0.65;
  lv.lineLimit = 1;

  row.addSpacer();

  const rl = row.addText(String(rLabel));
  rl.font = Font.mediumSystemFont(fs);
  rl.textColor = Color.gray();
  row.addSpacer(5);

  const rv = row.addText(String(rValue));
  rv.font = Font.semiboldSystemFont(fs);
  rv.textColor = o.rightColor || Color.white();
  rv.minimumScaleFactor = 0.65;
  rv.lineLimit = 1;
}

/**
 * Draws a bar-chart sparkline using DrawContext.
 * @param points  Oldest-first array of `used` values.
 * @param width   Image width in points.
 * @param height  Image height in points.
 * @param color   Scriptable Color for the bars.
 */
function createSparklineImage(points, width, height, color) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.respectScreenScale = true;
  ctx.opaque = false;

  const n = points.length;
  if (n === 0) return ctx.getImage();

  const maxVal = Math.max(...points, 1);
  const barWidth = width / n;
  const gap = Math.max(0.5, barWidth * 0.12);

  for (let i = 0; i < n; i++) {
    const barHeight = Math.max(2, (points[i] / maxVal) * height);
    const x = i * barWidth + gap / 2;
    const y = height - barHeight;
    const w = Math.max(1, barWidth - gap);
    ctx.setFillColor(color);
    ctx.fillRect(new Rect(x, y, w, barHeight));
  }

  return ctx.getImage();
}

// --- Widget size layouts --------------------------------------------------

/**
 * Small widget — glanceable, at most 4 metrics.
 *
 * Information architecture:
 *   CopeLimit              [live]
 *   1,450                         <- hero: overage (budget_active) or remaining
 *   remaining of 7,000
 *
 *   Budget in use                 <- most important state
 *   Resets  Jun 30
 */
function createSmallWidget(usage) {
  const widget = makeBaseWidget(12);
  const isBudgetActive = !usage.error && usage.billingPhase === "budget_active";
  const accent = new Color(colourHexFor(usage));
  const overageValue = usage.overageCount ?? usage.derivedOverageCredits ?? 0;

  // Title + source badge
  const titleRow = widget.addStack();
  titleRow.layoutHorizontally();
  const title = titleRow.addText("CopeLimit");
  title.font = Font.boldSystemFont(12);
  title.textColor = Color.white();
  titleRow.addSpacer();
  const badge = titleRow.addText(sourceLabel(usage.source));
  badge.font = Font.semiboldSystemFont(9);
  badge.textColor = accent;

  widget.addSpacer(3);

  // Hero: budget_active priority — show overage over remaining
  const heroValue = isBudgetActive
    ? `+${formatNumber(overageValue)}`
    : formatNumber(usage.remaining ?? 0);
  const hero = widget.addText(heroValue);
  hero.font = Font.heavySystemFont(34);
  hero.textColor = accent;
  hero.minimumScaleFactor = 0.5;
  hero.lineLimit = 1;

  const captionStr = isBudgetActive
    ? `overage of ${formatNumber(usage.quota)}`
    : `remaining of ${formatNumber(usage.quota)}`;
  const caption = widget.addText(captionStr);
  caption.font = Font.mediumSystemFont(10);
  caption.textColor = Color.gray();
  caption.minimumScaleFactor = 0.65;
  caption.lineLimit = 1;

  widget.addSpacer();

  // Most important state label
  if (!usage.error) {
    const phase = widget.addText(billingPhaseLabel(usage.billingPhase));
    phase.font = Font.semiboldSystemFont(10);
    phase.textColor = accent;
    phase.lineLimit = 1;
  } else {
    const err = widget.addText("Error");
    err.font = Font.semiboldSystemFont(10);
    err.textColor = new Color("#ef4444");
  }

  addMetricRow(widget, "Resets", formatShortDate(usage.resetAt), { fontSize: 10, muted: true });

  return widget;
}

/**
 * Medium widget — current layout baseline with improved information density.
 *
 * Information architecture:
 *   Left column:  Hero number + caption
 *   Right column: Used (%), Budget (if active), Burn rate, Reset, Phase badge
 */
function createMediumWidget(usage) {
  const widget = makeBaseWidget(14);
  const isBudgetActive = !usage.error && usage.billingPhase === "budget_active";
  const accent = new Color(colourHexFor(usage));
  const overageValue = usage.overageCount ?? usage.derivedOverageCredits ?? 0;
  const burnLabel = formatBurnRate(usage.widgetExtras ? usage.widgetExtras.burnRate : null);

  // Title row
  const titleRow = widget.addStack();
  titleRow.layoutHorizontally();
  const title = titleRow.addText("CopeLimit");
  title.font = Font.boldSystemFont(14);
  title.textColor = Color.white();
  titleRow.addSpacer();
  const badge = titleRow.addText(sourceLabel(usage.source));
  badge.font = Font.semiboldSystemFont(11);
  badge.textColor = accent;

  widget.addSpacer(6);

  // Two-column body
  const body = widget.addStack();
  body.layoutHorizontally();

  // Left: hero + caption
  const leftCol = body.addStack();
  leftCol.layoutVertically();

  const heroValue = isBudgetActive
    ? `+${formatNumber(overageValue)}`
    : formatNumber(usage.remaining ?? 0);
  const hero = leftCol.addText(heroValue);
  hero.font = Font.heavySystemFont(38);
  hero.textColor = accent;
  hero.minimumScaleFactor = 0.45;
  hero.lineLimit = 1;

  const captionStr = isBudgetActive
    ? `overage of ${formatNumber(usage.quota)}`
    : `remaining of ${formatNumber(usage.quota)}`;
  const caption = leftCol.addText(captionStr);
  caption.font = Font.mediumSystemFont(10);
  caption.textColor = Color.gray();
  caption.minimumScaleFactor = 0.65;
  caption.lineLimit = 1;

  body.addSpacer();

  // Right: metric rows
  const rightCol = body.addStack();
  rightCol.layoutVertically();

  if (usage.error) {
    const errTxt = rightCol.addText("Error");
    errTxt.font = Font.semiboldSystemFont(11);
    errTxt.textColor = new Color("#ef4444");
  } else {
    const usedPct = usage.percentUsed > 100
      ? `${formatNumber(usage.used)} (${usage.percentUsed}%!)`
      : `${formatNumber(usage.used)} (${usage.percentUsed}%)`;
    addMetricRow(rightCol, "Used", usedPct, { fontSize: 11 });

    if (isBudgetActive && usage.overageEntitlement !== undefined) {
      addMetricRow(rightCol, "Budget", formatNumber(usage.overageEntitlement), { fontSize: 11 });
    }

    if (burnLabel) {
      addMetricRow(rightCol, "Burn", burnLabel, { fontSize: 11 });
    }

    addMetricRow(rightCol, "Reset", formatShortDate(usage.resetAt), { fontSize: 11, muted: true });

    const phaseTxt = rightCol.addText(billingPhaseLabel(usage.billingPhase));
    phaseTxt.font = Font.semiboldSystemFont(10);
    phaseTxt.textColor = accent;
    phaseTxt.lineLimit = 1;
  }

  return widget;
}

/**
 * Large widget — telemetry dashboard with sparkline trend visual.
 *
 * Information architecture:
 *   Header:   CopeLimit + source badge
 *   Grid:     Used/Quota | Overage/Budget | Burn rate/ETA | Resets/Phase
 *   Trend:    Bar sparkline (oldest-to-newest, up to 14 snapshots)
 */
function createLargeWidget(usage) {
  const widget = makeBaseWidget(16);
  const isBudgetActive = !usage.error && usage.billingPhase === "budget_active";
  const accent = new Color(colourHexFor(usage));
  const overageValue = usage.overageCount ?? usage.derivedOverageCredits ?? 0;
  const extras = usage.widgetExtras || null;
  const burnRate = extras ? extras.burnRate : null;
  const burnRateCostPerHourUsd = extras ? extras.burnRateCostPerHourUsd : null;
  const burnLabel = formatBurnRate(burnRate) || "—";
  const burnCostLabel = burnRateCostPerHourUsd === null || burnRateCostPerHourUsd === undefined
    ? "—"
    : `${formatUsd(burnRateCostPerHourUsd)}/hr`;
  const etaLabel = formatEta(computeEtaHours(usage, burnRate)) || "—";
  const sparkline = extras ? extras.sparkline : null;

  // Header
  const headerRow = widget.addStack();
  headerRow.layoutHorizontally();
  const title = headerRow.addText("CopeLimit");
  title.font = Font.boldSystemFont(16);
  title.textColor = Color.white();
  headerRow.addSpacer();
  const badge = headerRow.addText(sourceLabel(usage.source).toUpperCase());
  badge.font = Font.boldSystemFont(10);
  badge.textColor = accent;

  widget.addSpacer(6);

  if (usage.error) {
    const errTxt = widget.addText(`Error: ${usage.error}`);
    errTxt.font = Font.mediumSystemFont(12);
    errTxt.textColor = new Color("#ef4444");
    errTxt.lineLimit = 4;
    return widget;
  }

  // Metrics grid
  addTwoColRow(widget, "Used", formatNumber(usage.used), "Quota", formatNumber(usage.quota));
  widget.addSpacer(4);

  if (isBudgetActive || usage.overageEntitlement !== undefined) {
    const budgetDisplay = usage.overageEntitlement !== undefined
      ? formatNumber(usage.overageEntitlement)
      : "—";
    addTwoColRow(widget, "Overage", `+${formatNumber(overageValue)}`, "Budget", budgetDisplay,
      { leftColor: accent });
    widget.addSpacer(4);
    addTwoColRow(
      widget,
      "Overage $",
      formatUsd(usage.overageCostUsd),
      "Budget rem $",
      formatUsd(usage.estimatedRemainingBudgetCostUsd ?? usage.budgetRemainingCostUsd)
    );
    widget.addSpacer(4);
  }

  addTwoColRow(widget, "Burn rate", burnLabel, "ETA", etaLabel);
  widget.addSpacer(4);
  addTwoColRow(widget, "Burn $/hr", burnCostLabel, "Used $", formatUsd(usage.totalUsedCostUsd));
  widget.addSpacer(4);

  addTwoColRow(widget, "Resets", formatShortDate(usage.resetAt), "Phase",
    billingPhaseLabel(usage.billingPhase), { rightColor: accent });

  // Sparkline
  widget.addSpacer(8);

  const sep = widget.addText("—————————————————————————————");
  sep.font = Font.systemFont(6);
  sep.textColor = new Color("#374151");

  widget.addSpacer(6);

  if (sparkline && sparkline.length >= 2) {
    const trendLabel = widget.addText(`Usage trend  ·  ${sparkline.length} snapshots`);
    trendLabel.font = Font.mediumSystemFont(10);
    trendLabel.textColor = Color.gray();

    widget.addSpacer(5);

    const sparkColor = new Color(colourHexFor(usage), 0.8);
    const sparkImg = createSparklineImage(sparkline, 294, 44, sparkColor);
    const imgWidget = widget.addImage(sparkImg);
    imgWidget.imageSize = new Size(294, 44);
    imgWidget.cornerRadius = 3;
  } else {
    const noData = widget.addText("No usage trend data available");
    noData.font = Font.mediumSystemFont(10);
    noData.textColor = Color.gray();
  }

  return widget;
}

// --- Main -----------------------------------------------------------------

const family = config.widgetFamily;  // "small" | "medium" | "large" | null (in-app preview)
const DEFAULT_FAMILY = "medium";     // null means running directly in Scriptable for preview
const isLarge = family === "large";
const isMedium = family === DEFAULT_FAMILY || family === null;

let usage;
try {
  usage = await getUsage(isLarge);
} catch (error) {
  usage = {
    remaining: 0,
    quota: 0,
    used: 0,
    percentUsed: 0,
    resetAt: null,
    source: "error",
    warningLevel: "hot",
    billingPhase: null,
    error: error instanceof Error ? error.message : "Unknown error"
  };
}

let widget;
if (isLarge) {
  widget = createLargeWidget(usage);
} else if (isMedium) {
  widget = createMediumWidget(usage);
} else {
  widget = createSmallWidget(usage);
}

Script.setWidget(widget);
Script.complete();
