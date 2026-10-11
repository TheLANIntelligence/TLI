import type { ChatContext, ImageTask, ScreenshotReceipt, ScreenshotReview } from './types';

export const imageTasks: { id: ImageTask; label: string }[] = [
  { id: 'photo', label: 'Photo question' }, { id: 'explain', label: 'Explain this screen' },
  { id: 'error', label: 'Understand an error' }, { id: 'next_step', label: 'Find the next step' },
];

// Build from the reviewed snapshot only. Normal device context never identifies
// the computer in a screenshot, and no diagnostic is selected implicitly here.
export function reviewedImageContext(context: ChatContext, review: ScreenshotReview | undefined, task: ImageTask, computer: string, other: string): ChatContext {
  if (!context.photo) return context;
  if (!review?.provider || !/^[a-f0-9]{64}$/.test(review.provider.key)) throw new Error(review?.reason || 'Review the AI destination before sending this photo. Tap Recheck.');
  const base = { ...context, screenshot: undefined, image_provider_key: review.provider.key };
  if (task === 'photo') return base;
  const target = review.computers.find(item => item.id === computer);
  if (computer !== 'unknown' && computer !== 'other' && !target) throw new Error('This computer is no longer listed. Choose the computer again.');
  if (computer === 'other' && !other.trim()) throw new Error('Name the computer shown, or choose Unknown computer.');
  if (other.trim().length > 120) throw new Error('Use a computer name of 120 characters or fewer.');
  return { ...base, target_id: undefined, screenshot: { task, provider_key: review.provider.key,
    ...(target ? { target_id: target.id } : computer === 'other' ? { other_computer: other.trim() } : {}) } };
}

export function screenshotReceiptText(receipt?: ScreenshotReceipt): string | undefined {
  if (!receipt || receipt.capture !== 'user_shared_snapshot' || receipt.actions_performed !== false || !['explain', 'error', 'next_step'].includes(receipt.task)) return;
  return `${imageTasks.find(item => item.id === receipt.task)?.label} · ${receipt.computer?.name || 'Unknown computer'}${receipt.report_id ? ' · saved diagnostic attached' : ''} · Guidance only; no actions performed. Attach a new image to show the next screen.`;
}
