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
} from "./types.js";
import { SubstackAPIError, AuthenticationError } from "../utils/errors.js";

export class SubstackClient {
  private publicationUrl: string;
  private cookie: string;
  private userId: number;

  constructor(publicationUrl: string, sessionToken: string, userId: string) {
    this.publicationUrl = publicationUrl.replace(/\/$/, "");
    // Substack uses connect.sid on custom domains, substack.sid on substack.com
    this.cookie = `connect.sid=${sessionToken}; substack.sid=${sessionToken};`;
    this.userId = parseInt(userId, 10);

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
      "Content-Type": "application/json",
      "User-Agent": "substack-mcp/0.2.2",
      ...(options.headers as Record<string, string> || {}),
    };

    const response = await fetch(url, {
      ...options,
      headers,
      redirect: "follow",
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthenticationError(url);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "unknown error");
      throw new SubstackAPIError(response.status, body, url);
    }

    return response.json() as Promise<T>;
  }

  async validateAuth(): Promise<{ id: number; name: string }> {
    // /user/self is restricted; validate by fetching drafts instead
    const drafts = await this.request<SubstackDraft[]>(
      `${this.publicationUrl}/api/v1/drafts?limit=1`,
    );
    // If we get here without a 401/403, auth is valid
    const byline = drafts[0]?.draft_bylines?.[0];
    return { id: byline?.id ?? this.userId, name: "authenticated" };
  }

  async getSubscriberCount(): Promise<{ count: number; note: string }> {
    // Try multiple endpoints — Substack's API is inconsistent
    try {
      const data = await this.request<Record<string, unknown>>(
        `${this.publicationUrl}/api/v1/publication_launch_checklist`,
      );
      if (typeof data.subscriber_count === "number") {
        return { count: data.subscriber_count, note: "exact" };
      }
      if (typeof data.subscriberCount === "number") {
        return { count: data.subscriberCount, note: "exact" };
      }
      // The subscribers field is a paginated sample, not the full list
      if (Array.isArray(data.subscribers)) {
        return {
          count: data.subscribers.length,
          note: "sample only — this is a paginated subset, not the total. Check your Substack dashboard for the exact count.",
        };
      }
    } catch {
      // Fall through
    }
    return { count: -1, note: "Could not retrieve subscriber count. Check your Substack dashboard." };
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
    return this.request<SubstackDraft[]>(
      `${this.publicationUrl}/api/v1/drafts?offset=${offset}&limit=${limit}`,
    );
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
