import { redirectPairingLink } from '../src/pairing-link';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  // Never pass a pairing token/certificate to route parameters or error logs.
  return redirectPairingLink(path) ?? path;
}
