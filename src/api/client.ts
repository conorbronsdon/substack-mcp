import {
  SubstackUser,
  SubstackPost,
  SubstackDraft,
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
    this.cookie = `substack.sid=${sessionToken}; connect.sid=${sessionToken};`;
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
      "User-Agent": "substack-mcp/0.1.0",
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

  async validateAuth(): Promise<SubstackUser> {
    return this.request<SubstackUser>(
      "https://substack.com/api/v1/user/self",
    );
  }

  async getSubscriberCount(): Promise<number> {
    const data = await this.request<{ subscriber_count?: number; subscriberCount?: number }>(
      `${this.publicationUrl}/api/v1/publication_launch_checklist`,
    );
    return data.subscriber_count ?? data.subscriberCount ?? 0;
  }

  async getPublishedPosts(
    offset = 0,
    limit = 25,
  ): Promise<SubstackPost[]> {
    return this.request<SubstackPost[]>(
      `${this.publicationUrl}/api/v1/post_management/published?offset=${offset}&limit=${limit}&order_by=post_date&order_direction=desc`,
    );
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
}
