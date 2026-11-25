/**
 * Every place this device keeps a person's connection to another network, plus what Open Media
 * remembers about posts copied there. All of it belongs to the signed-in person, so it is removed
 * on sign-out and on account deletion: the next person using this device must never post as them
 * (LinkedIn API Terms §3.1, §4.4; see docs/compliance/linkedin.md).
 */
export const networkSessionPrefix = 'open-media.network.';

export const networkSessionKeys = [
  'open-media.network.x', 'open-media.network.threads', 'open-media.network.linkedin',
  'open-media.network.instagram', 'open-media.network.facebook',
  'open-media.network.bluesky', 'open-media.network.mastodon', 'open-media.network.mastodon.apps', 'open-media.network.nostr',
  'open-media.network.farcaster', 'open-media.network.farcaster.fid', 'open-media.network.lens',
  'open-media.network.hive', 'open-media.network.hive.session', 'open-media.network.deso',
  'open-media.cross-posting.ledger', 'open-media.cross-posting.posts', 'open-media.network-interactions',
] as const;

/** Whether a stored key is one of the person's network connections or cross-post records. */
export function isNetworkSessionKey(key: string): boolean {
  return key.startsWith(networkSessionPrefix) || (networkSessionKeys as readonly string[]).includes(key);
}
