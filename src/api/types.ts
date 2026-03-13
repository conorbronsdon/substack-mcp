export interface SubstackUser {
  id: number;
  name: string;
  handle: string;
  email: string;
  photo_url: string | null;
}

export interface SubstackPublication {
  id: number;
  name: string;
  subdomain: string;
  custom_domain: string | null;
  logo_url: string | null;
  author_id: number;
  theme_var_background_pop: string | null;
}

export interface SubstackPost {
  id: number;
  title: string;
  subtitle: string | null;
  slug: string;
  post_date: string | null;
  audience: string;
  type: string;
  draft_title?: string;
  draft_subtitle?: string;
  draft_body?: string;
  body_html?: string;
  canonical_url: string;
  word_count: number;
  description: string | null;
  cover_image: string | null;
  section_id: number | null;
}

export interface SubstackDraft {
  id: number;
  draft_title: string;
  draft_subtitle: string | null;
  draft_body: string | null;
  draft_bylines: Array<{ id: number; is_guest: boolean }>;
  audience: string;
  type: string;
  word_count: number;
  cover_image: string | null;
  section_id: number | null;
  draft_created_at: string;
  draft_updated_at: string;
}

export interface DraftCreatePayload {
  draft_title: string;
  draft_subtitle?: string;
  draft_body?: string;
  draft_bylines: Array<{ id: number; is_guest: boolean }>;
  audience?: "everyone" | "only_paid" | "founding" | "only_free";
  type?: "newsletter" | "podcast" | "thread";
  section_id?: number | null;
}

export interface DraftUpdatePayload {
  draft_title?: string;
  draft_subtitle?: string;
  draft_body?: string;
  audience?: "everyone" | "only_paid" | "founding" | "only_free";
  section_id?: number | null;
  cover_image?: string | null;
}

export interface PublicationLaunchChecklist {
  subscriber_count: number;
  [key: string]: unknown;
}

export interface ImageUploadResult {
  url: string;
}

export interface SubstackComment {
  id: number;
  body: string;
  body_json?: unknown;
  name: string;
  date: string;
  user_id: number;
  author_is_admin?: boolean;
  reactions?: Record<string, number>;
  children_count?: number;
}

export interface NoteCreatePayload {
  bodyJson: {
    type: "doc";
    attrs: { schemaVersion: "v1" };
    content: unknown[];
  };
  tabId: string;
  surface: string;
  replyMinimumRole: string;
  attachmentIds?: string[];
}

export interface SubstackNote {
  id: number;
  body: string;
  body_json?: unknown;
  date: string;
  name: string;
  reaction_count: number;
  restacks: number;
  children_count: number;
  attachments: unknown[];
}

export interface NoteAttachment {
  id: string;
  type: string;
}
