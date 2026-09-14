/** Limits for remote image downloads, kept free of Node imports so tool descriptions can quote them anywhere. */
export const REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const REMOTE_IMAGE_DEADLINE_MS = 15_000;
export const REMOTE_IMAGE_MAX_REDIRECTS = 3;
