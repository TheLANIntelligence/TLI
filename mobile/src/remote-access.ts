import { validateOrigin } from './protocol';

/** A routing hint for the existing pairing, never evidence that a VPN is active. */
export function privateNetworkPlan(origin: string) {
  try {
    const exact = validateOrigin(origin), url = new URL(exact);
    if (url.hostname.startsWith('169.254.')) return { eligible: false as const, reason: 'This pairing uses a link-local (169.254) address. At home, review a private LAN pairing address before using a routed connection. Your existing pairing has not changed.' };
    return { eligible: true as const, origin: exact, route: url.hostname + '/32', port: Number(url.port || 443), reason: 'Route this existing private LAN address through your externally managed private network. No route or access rule has been configured by TLI.' };
  } catch {
    return { eligible: false as const, reason: 'This is not a supported private LAN HTTPS pairing address. Review your existing pairing on the TLI desktop. Public URLs, direct Tailscale 100.x addresses and DNS names are not supported by this workflow.' };
  }
}

export const PRIVATE_NETWORK_STEPS = [
  'Pair at home first. Keep the exact HTTPS address and certificate already saved on this phone.',
  'Configure the private network outside TLI. For Tailscale, sign in on this phone and a compatible home subnet-router device. An existing WireGuard gateway can provide the route instead.',
  'Ask its administrator to advertise only the TLI host address (/32), approve the route and allow the intended phone or account to the HTTPS TCP port. Review broader existing access rules too.',
  'Keep TLI and the home gateway running. Away from home, enable your private-network client and deliberately check this connection. No message, command or save is queued for reconnection.',
] as const;

export const PRIVATE_NETWORK_LINKS = [
  { title: 'Tailscale subnet-router setup', url: 'https://tailscale.com/docs/features/subnet-routers' },
  { title: 'Tailscale access rules', url: 'https://tailscale.com/docs/reference/syntax/grants' },
  { title: 'WireGuard setup reference', url: 'https://www.wireguard.com/quickstart/' },
] as const;

export const PRIVATE_NETWORK_LIMIT = 'Remote path: not verified. A successful check confirms the paired host responded over verified HTTPS. It cannot establish which network carried the connection. Test from cellular or another network yourself.';
