import {
  SubstackUser,
  SubstackPost,
  SubstackDraft,
  SubstackComment,
  SubstackNote,
  NoteCreatePayload,
  NoteAttachment,
  DraftCreatePayload,
  DraftUpdatePayload,
  ImageUploadResult,
  SubstackSection,
  SubstackScheduledPost,
} from "./types.js";
import { mapHttpStatusToError, extractErrorDetail } from "../utils/errors.js";

/**
 * Largest `limit` Substack's post_management endpoints will accept.
 *
 * Probed directly against `/api/v1/post_management/published` (2026-08-02):
 * `limit=50` → HTTP 200, `limit=51` → HTTP 400
 * `{"errors":[{"location":"query","param":"limit","value":51,"msg":"Invalid value"}]}`,
 * `limit=100` → 400. So 51 is the exact boundary and 50 is the largest page the
 * API will serve. Never send a `limit` above this — the request fails outright
 * rather than returning a truncated page.
 */
export const MAX_PAGE_SIZE = 50;

/** Pages `getPostAnalytics` will scan before giving up. */
export const ANALYTICS_MAX_PAGES = 10;

/**
 * How many of the most recent published posts `getPostAnalytics` searches.
 * Derived, not stated: tool descriptions that quote this bound must interpolate
 * it so they can't rot when either factor changes.
 */
export const ANALYTICS_SCAN_DEPTH = MAX_PAGE_SIZE * ANALYTICS_MAX_PAGES;

/**
 * Parse Substack's order-of-magnitude subscriber bucket into a number.
 *
 * Values look like "1K+", "2.5K+", "750+", "1M+". Exported for tests.
 *
 * The previous implementation did `.replace("K", "000")`, which turns "2.5K"
 * into "2.5000" and then NaN — so any publication in a fractional-K bucket
 * silently lost its count.
 */
export function parseMagnitude(raw: string): number | null {
  const m = raw.trim().replace(/,/g, "").match(/^([\d.]+)\s*([KMkm]?)\+?$/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return null;
  const scale = m[2].toUpperCase() === "M" ? 1_000_000 : m[2].toUpperCase() === "K" ? 1_000 : 1;
  const n = Math.round(base * scale);
  return n > 0 ? n : null;
}

export class SubstackClient {
  private publicationUrl: string;
  private cookie: string;
  private userId: number;
  private userAgent: string;

  constructor(
    publicationUrl: string,
    sessionToken: string,
    userId: string,
    userAgent?: string,
  ) {
    this.publicationUrl = publicationUrl.replace(/\/$/, "");
    // Substack uses connect.sid on custom domains, substack.sid on substack.com
    this.cookie = `connect.sid=${sessionToken}; substack.sid=${sessionToken};`;
    this.userId = parseInt(userId, 10);
    // Substack sits behind Cloudflare, which rejects non-browser User-Agents
    // (the default Node/undici UA, "node", etc.) with HTTP 403 "error code:
    // 1010" on some publications — notably custom domains. Default to a browser
    // UA; allow override via SUBSTACK_USER_AGENT.
    this.userAgent =
      userAgent ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    if (isNaN(this.userId)) {
      throw new Error(`Invalid SUBSTACK_USER_ID: "${userId}" — must be a number`);
    }
  }

  private async request<T>(
    url: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
      // Without a Referer, Substack 301-redirects canonical *.substack.com API
      // calls to the publication's custom domain; following that redirect lands
      // on a 401. Presenting the publish UI as referer keeps the request
      // first-party and served directly.
      Referer: `${this.publicationUrl}/publish/home`,
      ...(options.headers as Record<string, string> || {}),
    };

    // Only send Content-Type when there's a body. A bodyless GET carrying
    // Content-Type is a non-browser signature — the same class of tell the
    // browser UA/Referer above exist to avoid. Respect a caller override.
    if (options.body && !("Content-Type" in headers)) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      ...options,
      headers,
      redirect: "follow",
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown error");
      const detail = extractErrorDetail(body, "unknown error");
      throw mapHttpStatusToError(response.status, detail, url);
    }

    return response.json() as Promise<T>;
  }

  async validateAuth(): Promise<{ id: number; name: string }> {
    // /user/self is restricted; validate by listing drafts instead.
    const drafts = await this.getDrafts(0, 1);
    // If we get here without a 401/403, auth is valid
    const byline = drafts[0]?.draft_bylines?.[0];
    return { id: byline?.id ?? this.userId, name: "authenticated" };
  }

  /**
   * Subscriber count, with its precision stated rather than implied.
   *
   * As of 2026-07, `publication_launch_checklist` no longer returns
   * `subscriber_count`/`subscriberCount` — it returns `subscribers` as an
   * ~11-item paginated SAMPLE. This method used to fall back to that array's
   * length, which reported "11 subscribers" for a publication with over a
   * thousand. A wrong number with a caveat attached is still a wrong number:
   * callers (and models reading the tool result) use the integer, not the prose.
   * So the sample is never counted.
   *
   * Substack rounds the free subscriber count on every surface reachable without
   * its internal dashboard API — the public page AND the authenticated
   * /publish/home payload both report e.g. "1,000" for a true 1,073. So
   * `approximate` is the honest ceiling for the fallback path, and callers should
   * render it hedged ("1,000+") rather than as an exact figure.
   */
  async getSubscriberCount(): Promise<{
    count: number;
    precision: "exact" | "approximate" | "unavailable";
    note: string;
  }> {
    try {
      const data = await this.request<Record<string, unknown>>(
        `${this.publicationUrl}/api/v1/publication_launch_checklist`,
      );
      // Kept in case Substack restores these fields.
      if (typeof data.subscriber_count === "number") {
        return { count: data.subscriber_count, precision: "exact", note: "Exact count from the publication API." };
      }
      if (typeof data.subscriberCount === "number") {
        return { count: data.subscriberCount, precision: "exact", note: "Exact count from the publication API." };
      }
    } catch {
      // Fall through to the public page.
    }

    const rounded = await this.getRoundedSubscriberCount();
    if (rounded !== null) {
      return {
        count: rounded,
        precision: "approximate",
        note:
          `Approximate — Substack rounds this value, so the true count is ${rounded} or higher. ` +
          "Render it hedged (e.g. \"" + rounded.toLocaleString("en-US") + "+\"), not as exact. " +
          "The publication API no longer exposes an exact count; see your Substack dashboard.",
      };
    }

    return {
      count: -1,
      precision: "unavailable",
      note: "Could not retrieve subscriber count. Check your Substack dashboard.",
    };
  }

  /**
   * Scrape the rounded free-subscriber count off the publication page.
   * Returns null when no count can be parsed. Never throws.
   */
  private async getRoundedSubscriberCount(): Promise<number | null> {
    let html: string;
    try {
      const res = await fetch(`${this.publicationUrl}/`, {
        headers: { "User-Agent": this.userAgent },
        redirect: "follow",
      });
      if (!res.ok) return null;
      html = await res.text();
    } catch {
      return null;
    }

    // Substack embeds JSON in script tags with escaped quotes.
    const normalized = html.replace(/\\"/g, '"');

    const exactish = normalized.match(/"freeSubscriberCount"\s*:\s*"?([\d,]+)"?/);
    if (exactish) {
      const n = parseInt(exactish[1].replace(/,/g, ""), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }

    // Order-of-magnitude bucket, e.g. "1K+", "2.5K+", "750+".
    const oom = normalized.match(/"freeSubscriberCountOrderOfMagnitude"\s*:\s*"([^"]+)"/);
    if (oom) {
      const n = parseMagnitude(oom[1]);
      if (n !== null) return n;
    }

    return null;
  }

  async getPublishedPosts(
    offset = 0,
    limit = 25,
  ): Promise<{ posts: SubstackPost[]; total: number }> {
    const data = await this.request<{ posts: SubstackPost[]; total: number; offset: number; limit: number }>(
      `${this.publicationUrl}/api/v1/post_management/published?offset=${offset}&limit=${limit}&order_by=post_date&order_direction=desc`,
    );
    return { posts: data.posts || [], total: data.total || 0 };
  }

  async getDrafts(offset = 0, limit = 25): Promise<SubstackDraft[]> {
    // The bare /api/v1/drafts collection returns 403 "Not authorized" on many
    // publications; /api/v1/post_management/drafts is the endpoint the Substack
    // editor itself uses. It requires explicit ordering params and returns the
    // drafts wrapped in { posts, total } rather than a bare array.
    const data = await this.request<{ posts: SubstackDraft[]; total?: number }>(
      `${this.publicationUrl}/api/v1/post_management/drafts?offset=${offset}&limit=${limit}&order_by=draft_updated_at&order_direction=desc`,
    );
    return data.posts || [];
  }

  async getDraft(id: number): Promise<SubstackDraft> {
    return this.request<SubstackDraft>(
      `${this.publicationUrl}/api/v1/drafts/${id}`,
    );
  }

  async getPost(id: number): Promise<SubstackPost> {
    return this.request<SubstackPost>(
      `${this.publicationUrl}/api/v1/posts/${id}`,
    );
  }

  async createDraft(
    title: string,
    body?: string,
    subtitle?: string,
    audience: string = "everyone",
  ): Promise<SubstackDraft> {
    const payload: DraftCreatePayload = {
      draft_title: title,
      draft_bylines: [{ id: this.userId, is_guest: false }],
      audience: audience as DraftCreatePayload["audience"],
      type: "newsletter",
    };

    if (subtitle) payload.draft_subtitle = subtitle;
    if (body) payload.draft_body = body;

    return this.request<SubstackDraft>(
      `${this.publicationUrl}/api/v1/drafts`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  async updateDraft(
    id: number,
    updates: DraftUpdatePayload,
  ): Promise<SubstackDraft> {
    return this.request<SubstackDraft>(
      `${this.publicationUrl}/api/v1/drafts/${id}`,
      {
        method: "PUT",
        body: JSON.stringify(updates),
      },
    );
  }

  async uploadImage(imageBase64: string): Promise<ImageUploadResult> {
    return this.request<ImageUploadResult>(
      `${this.publicationUrl}/api/v1/image`,
      {
        method: "POST",
        body: JSON.stringify({ image: imageBase64 }),
      },
    );
  }

  async getPostComments(
    postId: number,
    limit = 20,
  ): Promise<SubstackComment[]> {
    const data = await this.request<{ comments: SubstackComment[] }>(
      `${this.publicationUrl}/api/v1/post/${postId}/comments`,
    );
    const comments = data.comments || [];
    return comments.slice(0, limit);
  }

  async getSections(): Promise<SubstackSection[]> {
    // Substack exposes no dedicated sections endpoint; the sections list rides
    // along on the subscriptions payload, one entry per publication you belong
    // to. Pick the entry whose hostname (or custom domain) matches this
    // publication. Mirrors python-substack's approach, extended to also match
    // on custom_domain so custom-domain publications resolve correctly.
    const data = await this.request<{
      publications?: Array<{
        hostname?: string;
        custom_domain?: string | null;
        sections?: SubstackSection[];
      }>;
    }>(`${this.publicationUrl}/api/v1/subscriptions`);

    const publications = data.publications || [];
    // Match on exact host, not substring — the subscriptions payload lists
    // every publication you follow, so `includes` would let an unrelated
    // `ample.substack.com` match `example.substack.com` and return the wrong
    // sections.
    let host: string;
    try {
      host = new URL(this.publicationUrl).hostname;
    } catch {
      host = this.publicationUrl;
    }
    const match = publications.find(
      (p) => p.hostname === host || p.custom_domain === host,
    );
    return match?.sections || [];
  }

  async getScheduledPosts(
    offset = 0,
    limit = 25,
  ): Promise<SubstackScheduledPost[]> {
    // `scheduled` is a distinct post_management view (sibling of `published`
    // and `drafts`). Each row carries a `trigger_at` future publish time.
    const data = await this.request<{ posts?: SubstackScheduledPost[] }>(
      `${this.publicationUrl}/api/v1/post_management/scheduled?offset=${offset}&limit=${limit}&order_by=trigger_at&order_direction=asc`,
    );
    return data.posts || [];
  }

  async getPostAnalytics(postId: number): Promise<SubstackPost | null> {
    // Substack has no per-post stats endpoint. Each row of the published
    // feed already carries a `stats` object, so page through the feed
    // (newest first) until the matching id turns up. Bounded so a bad id
    // can't scan forever: ANALYTICS_SCAN_DEPTH most recent published posts.
    //
    // Pages are awaited one at a time, so the worst case is ANALYTICS_MAX_PAGES
    // *sequential* requests, not a parallel burst — and that worst case only
    // occurs when the id isn't in the feed at all. A found post short-circuits.
    const pageSize = MAX_PAGE_SIZE;
    const maxPages = ANALYTICS_MAX_PAGES;
    for (let page = 0; page < maxPages; page++) {
      const { posts } = await this.getPublishedPosts(page * pageSize, pageSize);
      const found = posts.find((p) => p.id === postId);
      if (found) return found;
      if (posts.length < pageSize) break; // reached the end of the feed
    }
    return null;
  }

  async createNote(
    bodyJson: NoteCreatePayload["bodyJson"],
    attachmentIds?: string[],
  ): Promise<SubstackNote> {
    const payload: NoteCreatePayload = {
      bodyJson,
      tabId: "for-you",
      surface: "feed",
      replyMinimumRole: "everyone",
    };
    if (attachmentIds?.length) {
      payload.attachmentIds = attachmentIds;
    }
    return this.request<SubstackNote>(
      `${this.publicationUrl}/api/v1/comment/feed`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  async createNoteAttachment(url: string): Promise<NoteAttachment> {
    return this.request<NoteAttachment>(
      `${this.publicationUrl}/api/v1/comment/attachment`,
      {
        method: "POST",
        body: JSON.stringify({ url, type: "link" }),
      },
    );
  }
}
