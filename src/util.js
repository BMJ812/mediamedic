export function normalized(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function bestTitleMatches(items, query, limit = 20) {
  const q = normalized(query);
  if (!q) return [];
  return items
    .map((item) => {
      const title = normalized(item.title);
      let score = 0;
      if (title === q) score = 1000;
      else if (title.startsWith(q)) score = 700;
      else if (title.includes(q)) score = 500;
      else {
        const words = q.split(" ");
        score = words.reduce((sum, word) => sum + (title.includes(word) ? 40 : 0), 0);
      }
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map((x) => x.item);
}

export function bytes(value) {
  if (!value || value < 1) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

function inferredQualityFromFilename(value) {
  const text = String(value ?? "");
  if (!text) return undefined;
  const resolution = text.match(/\b(2160p|1080p|720p|576p|480p)\b/i)?.[1];
  const source =
    text.match(/\b(remux)\b/i)?.[1] ??
    text.match(/\bblu[ ._-]?ray\b/i)?.[0] ??
    text.match(/\bweb[ ._-]?dl\b/i)?.[0] ??
    text.match(/\bweb[ ._-]?rip\b/i)?.[0] ??
    text.match(/\bhdtv\b/i)?.[0] ??
    text.match(/\bdvd\b/i)?.[0];
  if (!resolution && !source) return undefined;
  const cleanSource = source ? source.replace(/[ ._]/g, "-").replace(/-+/g, "-") : undefined;
  return [cleanSource, resolution].filter(Boolean).join("-");
}

export function qualityName(file) {
  const direct =
    file?.quality?.quality?.name ??
    file?.quality?.name ??
    (typeof file?.quality === "string" ? file.quality : undefined);
  if (direct && direct !== "Unknown") return direct;
  return inferredQualityFromFilename(file?.relativePath ?? file?.path) ?? direct ?? "Unknown";
}

export function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}
