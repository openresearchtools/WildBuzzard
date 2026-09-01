/* SPDX-License-Identifier: AGPL-3.0-or-later */

export function isTorrentAddTarget(target) {
  return target === "/api/v2/torrents/add";
}

const MAX_MAGNET_SIZE = 32 * 1024;
const BTIH = /^urn:btih:(?:[a-f\d]{40}|[a-z2-7]{32})$/iu;

export function hasExplicitTorrentNavigation(loadInfo) {
  return loadInfo?.hasValidUserGestureActivation === true;
}

export function isValidBTIHMagnet(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("magnet:?") ||
    value.length > MAX_MAGNET_SIZE ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    /%(?![a-f\d]{2})/iu.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "magnet:" || url.hash) {
      return false;
    }
    for (const [name, parameter] of url.searchParams) {
      if (/[\p{Cc}\p{Cf}]/u.test(name) || /[\p{Cc}\p{Cf}]/u.test(parameter)) {
        return false;
      }
    }
    return url.searchParams
      .getAll("xt")
      .some(candidate => BTIH.test(candidate));
  } catch {
    return false;
  }
}

export function isPrivateTorrentLoad(context) {
  try {
    const top = context?.top;
    return Boolean(
      context?.originAttributes?.privateBrowsingId ||
      context?.usePrivateBrowsing ||
      top?.usePrivateBrowsing ||
      context?.currentWindowGlobal?.documentPrincipal?.originAttributes
        ?.privateBrowsingId ||
      top?.currentWindowGlobal?.documentPrincipal?.originAttributes
        ?.privateBrowsingId
    );
  } catch {
    return true;
  }
}
