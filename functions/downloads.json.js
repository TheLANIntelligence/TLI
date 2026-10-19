import { updateFeedResponse } from '../website/update-feed.mjs';

// Existing clients use this URL. Keep package compatibility decisions here so
// an older validator is never offered files it cannot safely prepare.
export async function onRequest(context) {
  return updateFeedResponse(context.request, await context.next());
}
