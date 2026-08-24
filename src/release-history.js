import { normalized } from "./util.js";

function eventType(item) {
  return String(item?.eventType ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function isGrab(item) {
  return eventType(item) === "grabbed";
}

function isImport(item) {
  const type = eventType(item);
  return type === "downloadfolderimported" || type === "moviefolderimported" || type === "seriesfolderimported";
}

function cleanDownloadId(value) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function basename(value) {
  const text = String(value ?? "").trim().replace(/\\/g, "/");
  if (!text) return "";
  return text.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
}

function releaseKey(value) {
  const base = basename(value).replace(/\.[a-z0-9]{2,5}$/i, "");
  return normalized(base || value);
}

function historyPathValues(item) {
  const data = item?.data && typeof item.data === "object" ? item.data : {};
  return Object.entries(data)
    .filter(([key, value]) => typeof value === "string" && key.toLowerCase().includes("path"))
    .map(([, value]) => String(value));
}

function newest(items) {
  return [...items].sort((a, b) => {
    const ad = new Date(a?.date ?? 0).getTime();
    const bd = new Date(b?.date ?? 0).getTime();
    return bd - ad;
  })[0];
}

function grabResult(grab, confidence, detail) {
  if (!grab?.id) return undefined;
  return {
    matched: true,
    historyId: Number(grab.id),
    sourceTitle: String(grab.sourceTitle ?? "Unknown release"),
    downloadId: cleanDownloadId(grab.downloadId),
    confidence,
    detail,
  };
}

/**
 * Conservatively identify the Grabbed history row associated with the current
 * managed file. We only return a match when Radarr/Sonarr history provides a
 * strong linkage. If the evidence is ambiguous, callers must skip blocklisting.
 */
export function findOriginalGrab(historyInput, file) {
  const history = Array.isArray(historyInput)
    ? historyInput
    : Array.isArray(historyInput?.records)
      ? historyInput.records
      : [];
  const grabs = history.filter(isGrab);
  if (!grabs.length) {
    return { matched: false, detail: "No grabbed history entries were available for this item." };
  }

  const currentBase = basename(file?.path ?? file?.relativePath);
  if (currentBase) {
    const imports = history.filter(isImport).filter((item) =>
      historyPathValues(item).some((value) => basename(value) === currentBase),
    );
    const downloadIds = [...new Set(imports.map((item) => cleanDownloadId(item.downloadId)).filter(Boolean))];
    if (downloadIds.length === 1) {
      const sameDownload = grabs.filter((item) => cleanDownloadId(item.downloadId) === downloadIds[0]);
      const grab = newest(sameDownload);
      if (grab) {
        return grabResult(
          grab,
          "import-download-id",
          "Matched the current library filename to an import history row, then linked that import to its grabbed release by download ID.",
        );
      }
    }
  }

  const sceneName = String(file?.sceneName ?? "").trim();
  if (sceneName) {
    const wanted = releaseKey(sceneName);
    const matches = grabs.filter((item) => releaseKey(item.sourceTitle) === wanted);
    if (matches.length) {
      const downloadIds = [...new Set(matches.map((item) => cleanDownloadId(item.downloadId)).filter(Boolean))];
      if (matches.length === 1 || downloadIds.length <= 1) {
        const grab = newest(matches);
        return grabResult(
          grab,
          "scene-name",
          "Matched the managed file's scene name exactly to the grabbed release title.",
        );
      }
    }
  }

  return {
    matched: false,
    detail: "MediaMedic could not prove which grabbed history entry produced the current file, so it refused to guess.",
  };
}
