class ArrClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  async request(path, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
      }
      if (response.status === 204) return undefined;
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async queueRecords(extra = "") {
    const result = await this.request(`/api/v3/queue?page=1&pageSize=1000${extra}`);
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.records) ? result.records : [];
  }

  historyRecords(result) {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.records) ? result.records : [];
  }

  markHistoryFailed(historyId) {
    return this.request(`/api/v3/history/failed/${historyId}`, { method: "POST" });
  }
}

export class RadarrClient extends ArrClient {
  async health() {
    const status = await this.request("/api/v3/system/status");
    return status.version ?? "connected";
  }

  listMovies() { return this.request("/api/v3/movie"); }
  getMovie(id) { return this.request(`/api/v3/movie/${id}`); }
  getMovieFile(id) { return this.request(`/api/v3/moviefile/${id}`); }
  deleteMovieFile(id) { return this.request(`/api/v3/moviefile/${id}`, { method: "DELETE" }); }
  searchMovie(movieId) {
    return this.request("/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "MoviesSearch", movieIds: [movieId] }),
    });
  }

  async movieHistory(movieId) {
    try {
      return this.historyRecords(await this.request(`/api/v3/history/movie?movieId=${encodeURIComponent(movieId)}`));
    } catch (error) {
      const page = await this.request("/api/v3/history?page=1&pageSize=1000&sortKey=date&sortDirection=descending");
      return this.historyRecords(page).filter((item) => Number(item.movieId ?? item.movie?.id) === Number(movieId));
    }
  }

  async findQueueItem(movieId) {
    const records = await this.queueRecords("&includeMovie=true");
    return records.find((item) => Number(item.movieId ?? item.movie?.id) === Number(movieId));
  }
}

export class SonarrClient extends ArrClient {
  async health() {
    const status = await this.request("/api/v3/system/status");
    return status.version ?? "connected";
  }

  listSeries() { return this.request("/api/v3/series"); }
  getEpisodes(seriesId) { return this.request(`/api/v3/episode?seriesId=${seriesId}`); }
  getEpisode(id) { return this.request(`/api/v3/episode/${id}`); }
  getEpisodeFile(id) { return this.request(`/api/v3/episodefile/${id}`); }
  deleteEpisodeFile(id) { return this.request(`/api/v3/episodefile/${id}`, { method: "DELETE" }); }
  searchEpisodes(episodeIds) {
    return this.request("/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "EpisodeSearch", episodeIds }),
    });
  }

  searchSeason(seriesId, seasonNumber) {
    return this.request("/api/v3/command", {
      method: "POST",
      body: JSON.stringify({ name: "SeasonSearch", seriesId, seasonNumber }),
    });
  }

  async seriesHistory(seriesId) {
    try {
      return this.historyRecords(await this.request(`/api/v3/history/series?seriesId=${encodeURIComponent(seriesId)}&includeSeries=false&includeEpisode=true`));
    } catch (error) {
      const page = await this.request("/api/v3/history?page=1&pageSize=1000&sortKey=date&sortDirection=descending&includeSeries=false&includeEpisode=true");
      return this.historyRecords(page).filter((item) => Number(item.seriesId ?? item.series?.id) === Number(seriesId));
    }
  }

  async findQueueItem(episodeIds) {
    const wanted = new Set((episodeIds ?? []).map(Number));
    const records = await this.queueRecords("&includeEpisode=true&includeSeries=true");
    return records.find((item) => {
      const candidates = [item.episodeId, item.episode?.id, ...(Array.isArray(item.episodeIds) ? item.episodeIds : [])]
        .filter((value) => value != null)
        .map(Number);
      return candidates.some((id) => wanted.has(id));
    });
  }
}
