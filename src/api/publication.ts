import { z } from "zod";

const host = z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i);
export const publicationSummary = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(1000),
  subdomain: z.string().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i),
  custom_domain: host.nullish(),
  hero_text: z.string().max(5000).nullish(),
  language: z.string().max(100).nullish(),
  payments_state: z.string().max(100).nullish(),
  community_enabled: z.boolean().nullish(),
  podcast_enabled: z.boolean().nullish(),
  invite_only: z.boolean().nullish(),
  paused: z.boolean().nullish(),
});

export const publicationOutput = z.object({
  publication: z.string(),
  publication_url: z.string().url(),
  data: publicationSummary,
  fields_not_returned_by_api: z.array(z.string()),
  identity_scope: z.literal("Publication host matched; account identity and role are not verified."),
});

/** Project metadata only. Never return arbitrary account payloads or infer roles. */
export async function getPublication(
  publicationUrl: string,
  read: (path: string) => Promise<unknown>,
) {
  const origin = new URL(publicationUrl);
  const parsed = publicationSummary.safeParse(await read("/api/v1/publication"));
  if (!parsed.success) throw new Error("Unexpected publication response; publication context cannot be verified.");
  const data = parsed.data;
  const hosts = [`${data.subdomain}.substack.com`, data.custom_domain].filter(Boolean);
  if (!hosts.some(value => value!.toLowerCase() === origin.hostname.toLowerCase())) {
    throw new Error("Publication response does not match the configured publication host.");
  }
  return {
    publication_url: origin.origin,
    data,
    fields_not_returned_by_api: Object.keys(publicationSummary.shape).filter(key => !(key in data)),
    identity_scope: "Publication host matched; account identity and role are not verified." as const,
  };
}
