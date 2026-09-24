import assert from 'node:assert/strict';

export const expectedTools = [
  'export_draft',
  'add_free_subscriber', 'create_draft', 'create_note', 'create_note_with_link',
  'get_draft', 'get_post', 'get_post_analytics', 'get_post_comments', 'get_sections',
  'get_subscriber', 'get_subscriber_count', 'list_drafts', 'list_published_posts',
  'list_scheduled_posts', 'list_subscribers', 'search_subscribers', 'update_draft', 'update_draft_tags', 'upload_image',
  'search_posts', 'preflight_draft', 'plan_draft_update',
  'get_publication',
  'list_publication_tags', 'get_post_tags', 'rank_posts', 'get_publication_stats', 'get_growth_sources',
  'get_user_profile', 'get_profile_feed', 'get_note_thread', 'list_public_posts', 'get_public_post',
].sort();

export function assertExpectedTools(tools) {
  assert.deepEqual(tools.map(tool => tool.name).sort(), expectedTools);
}
