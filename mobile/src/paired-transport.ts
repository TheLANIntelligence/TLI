import type { Transport } from './client';
import type { PairingCode } from './types';
import { validateOrigin } from './protocol';

type Trust = Pick<PairingCode, 'version'|'origin'|'certificate_der'|'node_id'|'public_key'>;
const successfulRoutes = new WeakMap<Transport, {identity:string; address:string}>();
function privateRoute(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return false;
  try { return new URL(validateOrigin('https://'+value)).hostname === value; } catch { return false; }
}

/** Hints select sockets, never a new origin, certificate, identity or credential. */
export async function configurePairing(transport: Transport, pairing: Trust) {
  const configuration = {origin:pairing.origin, certificateDer:pairing.certificate_der,
    ...(pairing.version === 2 ? {nodeId:pairing.node_id,publicKey:pairing.public_key} : {})};
  if (pairing.version !== 2) { await transport.configure(configuration); return; }
  if (!pairing.public_key || !transport.probeConnection) throw new Error('This native build cannot verify a stable host identity. Update the app before using this invitation.');
  const identity = JSON.stringify(configuration);
  const hostname = new URL(pairing.origin).hostname.endsWith('.local');
  const cached = successfulRoutes.get(transport);
  const [discovery, dns] = await Promise.allSettled([
    transport.discover?.({timeoutMs:2500}) ?? Promise.resolve([]),
    transport.resolveConnection?.({origin:pairing.origin,timeoutMs:2000}) ?? Promise.resolve([]),
  ]);
  const hints: string[] = [];
  if (discovery.status === 'fulfilled' && Array.isArray(discovery.value)) {
    for (const hint of discovery.value.slice(0,32)) {
      try { if (hint.nodeId === pairing.node_id && validateOrigin(hint.origin,true) === pairing.origin && Array.isArray(hint.addresses)) hints.push(...hint.addresses.slice(0,8).filter(privateRoute)); } catch { /* Reject this hint independently. */ }
    }
  }
  const addresses = hostname ? [...new Set([...(cached?.identity === identity ? [cached.address] : []),
    ...(dns.status === 'fulfilled' && Array.isArray(dns.value) ? dns.value.filter(privateRoute).slice(0,4) : []), ...hints])].slice(0,8) : [];
  const deadline = Date.now()+6000;
  let failure: unknown;
  // Only this credential-free challenge may try another address. Authenticated
  // application requests are sent once, on the single route that proved identity.
  for (const address of addresses.length ? addresses : [undefined]) {
    const remaining = deadline-Date.now(); if (remaining <= 0) break;
    try {
      const verified = await transport.probeConnection({...configuration,nodeId:pairing.node_id,publicKey:pairing.public_key,
        timeoutMs:Math.min(1500,remaining),...(address ? {resolvedAddresses:[address]} : {})});
      if (verified.verified !== true || verified.nodeId !== pairing.node_id || validateOrigin(verified.origin,true) !== pairing.origin || verified.publicKey !== pairing.public_key ||
          !Array.isArray(verified.resolvedAddresses) || (hostname && (verified.resolvedAddresses.length !== 1 || !privateRoute(verified.resolvedAddresses[0]) || address && verified.resolvedAddresses[0] !== address)))
        throw Object.assign(new Error('This connection did not prove the reviewed TLI identity. The saved pairing was retained.'), {code:'E_IDENTITY'});
      await transport.configure({...configuration,resolvedAddresses:verified.resolvedAddresses});
      if(hostname)successfulRoutes.set(transport,{identity,address:verified.resolvedAddresses[0]!});
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (['E_CANCELLED','E_LOCAL_NETWORK_PERMISSION','E_CERTIFICATE','E_UNSUPPORTED'].includes(code)) throw error;
      // Retain a trust failure if every candidate fails; a forged hint must not
      // conceal a valid route to the original reviewed identity.
      const previousCode = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : '';
      if (!['E_IDENTITY','E_TLS_TRUST'].includes(previousCode)) failure=error;
    }
  }
  throw failure || Object.assign(new Error('No private route to this TLI was verified. Check its secure LAN setup.'),{code:'E_NO_ROUTE'});
}
