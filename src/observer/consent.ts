import type { ContextBundle } from "../core/types.ts";

export interface RemoteObserverConsent {
  cloudObserverConsent: boolean;
  screenshotConsent: boolean;
}

export type RemoteObserverConsentReader = () => RemoteObserverConsent;

/** A final provider-boundary denial, distinct from a provider/network failure. */
export class RemoteObserverConsentError extends Error {
  constructor() {
    super("cloud observer consent is disabled");
    this.name = "RemoteObserverConsentError";
  }
}

/**
 * Re-check live consent at the last synchronous boundary before a remote fetch.
 * The observer's own image capability is also authoritative: callers cannot
 * accidentally bypass `includeImages: false` by handing it a richer bundle.
 */
export function bundleForRemoteObserver(
  bundle: ContextBundle,
  wantsImages: boolean,
  readConsent?: RemoteObserverConsentReader,
): ContextBundle {
  const consent = readConsent?.();
  if (consent && !consent.cloudObserverConsent) {
    throw new RemoteObserverConsentError();
  }
  const imagesAllowed = wantsImages && (consent?.screenshotConsent ?? true);
  return imagesAllowed && bundle.frameImages
    ? bundle
    : { ...bundle, frameImages: undefined };
}
