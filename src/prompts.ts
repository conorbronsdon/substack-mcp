import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP prompts and resources. Prompts are reusable workflows a client can offer
 * to the user (often as slash commands); each one only instructs the model to
 * chain existing tools, so prompts add no new endpoint, write path or
 * permission. The one resource lists configured publications from local
 * configuration, without a network call or any credential.
 */

export const PROMPT_NAMES = ["review_draft", "what_worked", "draft_from_idea", "plan_notes"] as const;
export const PUBLICATIONS_RESOURCE_URI = "substack://publications";

export interface PromptPublication {
  key: string;
  label: string;
  origin: string;
}

const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** Positive integer from a prompt argument (MCP prompt arguments are strings). */
export function intArg(value: string | undefined, fallback: number, max: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function registerPromptsAndResources(server: McpServer, publications: PromptPublication[]): void {
  const multi = publications.length > 1;
  const keys = publications.map((p) => p.key);
  // With one publication the tools take no `publication` field, so the prompts
  // must not mention one either. With several, every tool call needs it.
  const publicationArg: Record<string, z.ZodString> = multi
    ? { publication: z.string().describe(`Which publication: ${keys.join(", ")}.`) }
    : {};
  const target = (publication?: string) =>
    multi ? `Pass publication "${publication}" to every Substack tool call.\n\n` : "";

  server.registerPrompt(
    "review_draft",
    {
      title: "Review a draft before publishing",
      description: "Export a draft, run the static preflight and Substack's own prepublish check, and summarize what to fix. Reads only; edits go through the reviewed change flow.",
      argsSchema: { draft_id: z.string().describe("Numeric draft ID (from list_drafts or search_posts)."), ...publicationArg },
    },
    ({ draft_id, publication }: { draft_id: string; publication?: string }) =>
      user(
        `${target(publication)}Review Substack draft ${draft_id} before I publish it.\n\n` +
          `1. Call export_draft with draft_id ${draft_id} to read it as Markdown.\n` +
          `2. Call preflight_draft with draft_id ${draft_id} and substack_check true.\n` +
          "3. Report three things separately: the static preflight findings, Substack's own prepublish errors and suggestions (or that the check was unavailable), and your editorial read of the draft (headline, opening, structure, clarity).\n" +
          "4. If you propose edits, show them first. Only after I approve, call plan_draft_update, then update_draft with the same changes plus the complete receipt the plan returned.\n\n" +
          "This server cannot publish. A clean preflight is not publish approval; I publish in the Substack editor (preflight_draft returns the editor link).",
      ),
  );

  server.registerPrompt(
    "what_worked",
    {
      title: "What worked recently",
      description: "Rank recent posts and read publication and growth stats to find what drove opens, signups and subscriptions. Reads only.",
      argsSchema: {
        range_days: z.string().optional().describe("Look-back window in days (default 90, max 365)."),
        ...publicationArg,
      },
    },
    ({ range_days, publication }: { range_days?: string; publication?: string }) => {
      const days = intArg(range_days, 90, 365);
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      return user(
        `${target(publication)}Work out what has worked on my Substack over the last ${days} days.\n\n` +
          "1. Call rank_posts with metric \"subscribes\", then again with metric \"open_rate\" (limit 10 each).\n" +
          `2. Call get_publication_stats with range_days ${days}.\n` +
          `3. Call get_growth_sources with from_date ${iso(from)} and to_date ${iso(to)}.\n` +
          "4. Report the top and bottom posts with the metric each ranking used, the growth sources that brought subscribers, and three specific ideas for next posts tied to that evidence.\n\n" +
          "Keep each number's source next to it. When a value is missing or unavailable, say so; never treat missing as zero. If ranking coverage is partial, say how many posts it covered.",
      );
    },
  );

  server.registerPrompt(
    "draft_from_idea",
    {
      title: "Turn an idea into a draft",
      description: "Check past coverage, outline, then create a private draft and preflight it. Creates a draft only; nothing is published.",
      argsSchema: {
        idea: z.string().describe("The post idea, angle or working title."),
        audience: z.string().optional().describe("everyone (default), only_paid, founding or only_free."),
        ...publicationArg,
      },
    },
    ({ idea, audience, publication }: { idea: string; audience?: string; publication?: string }) => {
      const aud = ["everyone", "only_paid", "founding", "only_free"].includes(audience ?? "") ? audience : "everyone";
      return user(
        `${target(publication)}Help me turn this idea into a Substack draft: ${idea}\n\n` +
          "1. Call search_posts with a short query for the idea (status \"published\", then \"drafts\") so we do not repeat a past post or duplicate a draft in progress. Tell me what you found.\n" +
          "2. Propose a title, subtitle and outline, and wait for my go-ahead.\n" +
          `3. After I approve, write the post in Markdown and call create_draft with audience "${aud}".\n` +
          "4. Call preflight_draft on the new draft ID with substack_check true, report the findings, and give me the editor link.\n\n" +
          "The draft stays private until I publish it in Substack.",
      );
    },
  );

  server.registerPrompt(
    "plan_notes",
    {
      title: "Plan Substack Notes",
      description: "Propose Notes that point back to recent posts. Writes nothing on its own: Notes publish immediately, so each one needs explicit approval.",
      argsSchema: {
        count: z.string().optional().describe("How many Notes to propose (default 5, max 10)."),
        topic: z.string().optional().describe("Optional theme to focus on."),
        ...publicationArg,
      },
    },
    ({ count, topic, publication }: { count?: string; topic?: string; publication?: string }) => {
      const n = intArg(count, 5, 10);
      return user(
        `${target(publication)}Plan ${n} Substack Notes${topic ? ` about ${topic}` : ""}.\n\n` +
          "1. Call list_published_posts (limit 10) and rank_posts with metric \"views\" (limit 10) to pick posts worth resurfacing.\n" +
          `2. Draft ${n} Notes as plain text, each with the post it points to and why it should land now.\n\n` +
          "Do not call create_note or create_note_with_link in this workflow. A Note is public the moment it is created and has no draft state, so I will approve and post each one myself, one at a time, with its exact text.",
      );
    },
  );

  server.registerResource(
    "publications",
    PUBLICATIONS_RESOURCE_URI,
    {
      title: "Configured Substack publications",
      description: "The publications this server is configured for: the key to pass as `publication` (when there is more than one), a label and the origin. Local configuration only; no request to Substack, no credentials.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({
            publication_parameter_required: multi,
            publications: publications.map(({ key, label, origin }) => ({ key, label, origin })),
          }),
        },
      ],
    }),
  );
}
