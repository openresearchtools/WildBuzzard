// SPDX-License-Identifier: AGPL-3.0-or-later
/* globals locked, pref */

// WildBuzzard has no product telemetry, experiments, sponsored content,
// vendor updater, account, or promotional service. Keep these policy prefs
// together so they can be audited independently from upstream Firefox.

// Application and system-add-on updates are release artifacts, not an
// implicit connection to a Mozilla, Waterfox, or WildBuzzard service.
pref("app.update.enabled", false, locked);
pref("app.update.auto", false, locked);
pref("app.update.background.enabled", false, locked);
pref("app.update.service.enabled", false, locked);
pref("app.update.url.override", "", locked);
pref("extensions.systemAddon.update.enabled", false, locked);
pref("extensions.systemAddon.update.url", "", locked);

// No Mozilla support, marketing, release-note, feedback, or product links.
// about:blank keeps inherited "Learn more" controls local and non-networked.
pref("app.support.baseURL", "about:blank#", locked);
pref("app.feedback.baseURL", "about:blank", locked);
pref("app.releaseNotesURL", "about:blank", locked);
pref("app.releaseNotesURL.aboutDialog", "about:blank", locked);
pref("browser.uitour.enabled", false, locked);
pref("browser.uitour.url", "", locked);
pref("startup.homepage_override_url", "", locked);
pref("startup.homepage_welcome_url", "about:welcome", locked);
pref("startup.homepage_welcome_url.additional", "", locked);

// Telemetry, studies, remote experiments, coverage, and crash submission.
pref("datareporting.healthreport.uploadEnabled", false, locked);
pref("datareporting.policy.dataSubmissionEnabled", false, locked);
pref("toolkit.telemetry.enabled", false, locked);
pref("toolkit.telemetry.unified", false, locked);
pref("toolkit.telemetry.server", "", locked);
pref("toolkit.telemetry.server_owner", "WildBuzzard", locked);
pref("toolkit.telemetry.archive.enabled", false, locked);
pref("toolkit.telemetry.newProfilePing.enabled", false, locked);
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked);
pref("toolkit.telemetry.updatePing.enabled", false, locked);
pref("toolkit.telemetry.bhrPing.enabled", false, locked);
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked);
pref("toolkit.coverage.enabled", false, locked);
pref("toolkit.coverage.endpoint.base", "", locked);
pref("breakpad.reportURL", "", locked);
pref("toolkit.datacollection.infoURL", "about:blank", locked);
pref("datareporting.policy.firstRunURL", "about:blank", locked);
pref("datareporting.healthreport.infoURL", "about:blank", locked);
pref("toolkit.telemetry.dap_enabled", false, locked);
pref("toolkit.telemetry.dap_task1_enabled", false, locked);
pref("toolkit.telemetry.dap_visit_counting_enabled", false, locked);
pref("toolkit.telemetry.dap.leader.url", "", locked);
pref("toolkit.telemetry.dap.helper.url", "", locked);
pref("app.shield.optoutstudies.enabled", false, locked);
pref("app.normandy.enabled", false, locked);
pref("app.normandy.api_url", "", locked);
pref("messaging-system.rsexperimentloader.enabled", false, locked);

// Firefox Remote Settings and sponsored/recommendation feeds.
pref("services.settings.server", "", locked);
pref("services.settings.preview_enabled", false, locked);
pref("security.remote_settings.intermediates.enabled", false, locked);
pref("security.remote_settings.crlite_filters.enabled", false, locked);
pref("browser.discovery.enabled", false, locked);
pref(
  "browser.newtabpage.activity-stream.feeds.system.topstories",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.feeds.section.topstories",
  false,
  locked
);
pref("browser.newtabpage.activity-stream.showSponsored", false, locked);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked);
pref("browser.newtabpage.activity-stream.system.showSponsored", false, locked);
pref(
  "browser.newtabpage.activity-stream.system.showSponsoredTopSites",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.reportAds.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.imageProxy.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.merino-provider.endpoint",
  "",
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.ohttp.relayURL",
  "",
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.ohttp.configURL",
  "",
  locked
);
pref(
  "browser.newtabpage.activity-stream.telemetry.privatePing.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.useRemoteL10n",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.message-groups",
  '{"id":"message-groups","enabled":false,"type":"local"}',
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.cfr",
  '{"id":"cfr","enabled":false,"type":"local"}',
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments",
  '{"id":"messaging-experiments","enabled":false,"type":"local"}',
  locked
);
pref("messaging-system.askForFeedback", false, locked);
pref(
  "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features",
  false,
  locked
);
pref("browser.newtabpage.activity-stream.unifiedAds.endpoint", "", locked);
pref("browser.topsites.contile.enabled", false, locked);
pref("browser.topsites.contile.endpoint", "", locked);
pref("browser.topsites.useRemoteSetting", false, locked);
pref("browser.partnerlink.attributionURL", "", locked);
pref("browser.partnerlink.campaign.topsites", "", locked);
pref("browser.urlbar.quicksuggest.enabled", false, locked);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false, locked);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false, locked);
pref("browser.urlbar.merino.endpointURL", "", locked);
pref("browser.urlbar.merino.ohttpConfigURL", "", locked);
pref("browser.urlbar.merino.ohttpRelayURL", "", locked);
pref("browser.urlbar.merino.weather.reportEndpointURL", "", locked);
pref("browser.urlbar.merino.weather.hourlyEndpointURL", "", locked);
pref("dap.ohttp.relayURL", "", locked);
pref("browser.newtabpage.activity-stream.fxaccounts.endpoint", "", locked);
pref("browser.newtabpage.trainhopAddon.xpiBaseURL", "", locked);

// Mozilla product promotions.
pref("browser.preferences.moreFromMozilla", false, locked);
pref("browser.vpn_promo.enabled", false, locked);
pref("browser.promo.focus.enabled", false, locked);
pref("browser.promo.pin.enabled", false, locked);
pref("browser.contentblocking.report.lockwise.enabled", false, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);
pref("browser.contentblocking.report.vpn.url", "", locked);
pref("browser.contentblocking.report.vpn-promo.url", "", locked);
pref("browser.contentblocking.report.monitor.url", "about:blank", locked);
pref(
  "browser.contentblocking.report.monitor.how_it_works.url",
  "about:blank",
  locked
);
pref(
  "browser.contentblocking.report.monitor.sign_in_url",
  "about:blank",
  locked
);
pref(
  "browser.contentblocking.report.monitor.preferences_url",
  "about:blank",
  locked
);
pref(
  "browser.contentblocking.report.monitor.home_page_url",
  "about:blank",
  locked
);
pref(
  "browser.contentblocking.report.manage_devices.url",
  "about:blank",
  locked
);
pref("browser.contentblocking.report.endpoint_url", "", locked);
pref("browser.contentblocking.report.mobile-ios.url", "about:blank", locked);
pref(
  "browser.contentblocking.report.mobile-android.url",
  "about:blank",
  locked
);
pref("browser.contentblocking.report.vpn-android.url", "about:blank", locked);
pref("browser.contentblocking.report.vpn-ios.url", "about:blank", locked);
pref(
  "browser.contentblocking.report.lockwise.how_it_works.url",
  "about:blank",
  locked
);
pref("browser.contentblocking.report.social.url", "about:blank", locked);
pref("browser.contentblocking.report.cookie.url", "about:blank", locked);
pref("browser.contentblocking.report.tracker.url", "about:blank", locked);
pref("browser.contentblocking.report.fingerprinter.url", "about:blank", locked);
pref("browser.contentblocking.report.cryptominer.url", "about:blank", locked);
pref("identity.mobilepromo.android", "", locked);
pref("identity.mobilepromo.ios", "", locked);
pref("identity.fxaccounts.enabled", false, locked);
pref("identity.fxaccounts.toolbar.enabled", false, locked);
pref("identity.fxaccounts.remote.root", "", locked);
pref("identity.fxaccounts.remote.profile.uri", "", locked);
pref("identity.fxaccounts.remote.oauth.uri", "", locked);
pref("identity.fxaccounts.remote.pairing.uri", "", locked);
pref("identity.sync.tokenserver.uri", "", locked);
pref("identity.sendtabpromo.url", "about:blank", locked);
pref("identity.sendtab.deviceissues.url", "about:blank", locked);
pref(
  "identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled",
  false,
  locked
);
pref(
  "identity.fxaccounts.toolbar.pxiToolbarEnabled.relayEnabled",
  false,
  locked
);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.vpnEnabled", false, locked);
pref("signon.firefoxRelay.feature", "unavailable", locked);
pref("signon.firefoxRelay.base_url", "", locked);
pref("signon.firefoxRelay.learn_more_url", "about:blank", locked);
pref("signon.firefoxRelay.manage_url", "about:blank", locked);
pref("signon.firefoxRelay.terms_of_service_url", "about:blank", locked);
pref("signon.firefoxRelay.privacy_policy_url", "about:blank", locked);
pref("signon.recipes.remoteRecipes.enabled", false, locked);

// Do not contact Mozilla's add-on discovery, recommendation, blocklist, or
// update services. Local/manual extension installation remains available.
pref("extensions.getAddons.cache.enabled", false, locked);
pref("extensions.getAddons.get.url", "", locked);
pref("extensions.getAddons.search.browseURL", "about:blank", locked);
pref("extensions.getAddons.link.url", "about:blank", locked);
pref("extensions.getAddons.langpacks.url", "", locked);
pref("extensions.getAddons.discovery.api_url", "", locked);
pref("extensions.getAddons.browserMappings.url", "", locked);
pref("extensions.recommendations.privacyPolicyUrl", "about:blank", locked);
pref(
  "extensions.recommendations.themeRecommendationUrl",
  "about:blank",
  locked
);
pref("extensions.update.enabled", false, locked);
pref("extensions.update.autoUpdateDefault", false, locked);
pref("extensions.update.url", "", locked);
pref("extensions.update.background.url", "", locked);
pref("extensions.blocklist.enabled", false, locked);
pref("extensions.blocklist.url", "", locked);
pref("extensions.blocklist.detailsURL", "about:blank", locked);
pref("extensions.blocklist.itemURL", "about:blank", locked);
pref("extensions.blocklist.addonItemURL", "about:blank", locked);
pref("extensions.abuseReport.enabled", false, locked);
pref("extensions.abuseReport.amoFormURL", "about:blank", locked);
pref("extensions.addonAbuseReport.url", "", locked);
pref("extensions.webcompat-reporter.enabled", false, locked);
pref("extensions.webcompat-reporter.newIssueEndpoint", "about:blank", locked);
pref("browser.dictionaries.download.url", "about:blank", locked);
pref("lightweightThemes.getMoreURL", "about:blank", locked);
pref("browser.search.searchEnginesURL", "about:blank", locked);
pref("browser.geolocation.warning.infoURL", "about:blank", locked);
pref("browser.xr.warning.infoURL", "about:blank", locked);
pref("browser.lna.warning.infoURL", "about:blank", locked);
pref("pdfjs.altTextLearnMoreUrl", "about:blank", locked);
pref("pdfjs.commentLearnMoreUrl", "about:blank", locked);
pref("media.decoder-doctor.new-issue-endpoint", "about:blank", locked);
pref("devtools.performance.recording.ui-base-url", "about:blank", locked);
pref("devtools.remote.adb.extensionURL", "", locked);

// Do not use Mozilla connectivity probes or account/sync backends.
pref("network.captive-portal-service.enabled", false, locked);
pref("network.connectivity-service.enabled", false, locked);
pref("network.connectivity-service.IPv4.url", "", locked);
pref("network.connectivity-service.IPv6.url", "", locked);
pref("captivedetect.canonicalURL", "about:blank", locked);
pref("browser.region.network.url", "", locked);
pref("geo.provider.network.url", "", locked);
pref("services.sync.enabled", false, locked);
pref("dom.push.connection.enabled", false, locked);
pref("dom.push.serverURL", "", locked);
pref("webextensions.storage.sync.serverURL", "", locked);

// No automatic DNS partner. Users may deliberately configure their own DoH
// endpoint later by changing policy in a downstream or local build.
pref("network.trr.mode", 5, locked);
pref("network.trr.uri", "", locked);
pref("network.trr.custom_uri", "", locked);

// Experimental Mozilla-hosted browser surfaces and model services.
pref("browser.smartwindow.enabled", false, locked);
pref("browser.smartwindow.endpoint", "", locked);
pref("browser.smartwindow.worldcup.enabled", false, locked);
pref("browser.smartwindow.worldcup.endpointURL", "", locked);
pref("browser.ipProtection.enabled", false, locked);
pref("browser.ipProtection.blockIPProtectionCallouts", true, locked);
pref("browser.ipProtection.guardian.endpoint", "", locked);
pref("toolkit.shopping.ohttpConfigURL", "", locked);
pref("toolkit.shopping.ohttpRelayURL", "", locked);
pref("browser.ml.enable", false, locked);
pref("browser.ml.modelHubRootUrl", "", locked);
pref("browser.ml.chat.enabled", false, locked);
pref("browser.ml.chat.menu", false, locked);
pref("browser.ml.chat.page", false, locked);
pref("browser.ml.chat.sidebar", false, locked);
pref("browser.ml.linkPreview.enabled", false, locked);
pref("security.certerrors.mitm.priming.enabled", false, locked);
pref("security.certerrors.mitm.priming.endpoint", "", locked);
pref("media.gmp-manager.updateEnabled", false, locked);
pref("media.gmp-manager.url", "", locked);
pref("media.gmp-manager.chromium-update-url", "", locked);

// Partner-backed Safe Browsing would otherwise contact Google and Mozilla.
// The native WildBuzzard blocker remains active; a locally maintained malware
// feed can replace these endpoints without restoring vendor calls.
pref("browser.safebrowsing.malware.enabled", false, locked);
pref("browser.safebrowsing.phishing.enabled", false, locked);
pref("browser.safebrowsing.downloads.enabled", false, locked);
pref("browser.safebrowsing.downloads.remote.enabled", false, locked);
pref("browser.safebrowsing.downloads.remote.url", "", locked);
pref("browser.safebrowsing.provider.google.updateURL", "", locked);
pref("browser.safebrowsing.provider.google.gethashURL", "", locked);
pref("browser.safebrowsing.provider.google4.updateURL", "", locked);
pref("browser.safebrowsing.provider.google4.gethashURL", "", locked);
pref("browser.safebrowsing.provider.google4.dataSharingURL", "", locked);
pref("browser.safebrowsing.provider.google5.updateURL", "", locked);
pref("browser.safebrowsing.provider.google5.gethashURL", "", locked);
pref("browser.safebrowsing.provider.mozilla.gethashURL", "", locked);
pref("browser.safebrowsing.reportPhishURL", "about:blank", locked);

// Backup pages must not advertise or download another vendor's browser.
pref(
  "browser.backup.template.fallback-download.release",
  "about:blank",
  locked
);
pref("browser.backup.template.fallback-download.beta", "about:blank", locked);
pref("browser.backup.template.fallback-download.aurora", "about:blank", locked);
pref(
  "browser.backup.template.fallback-download.nightly",
  "about:blank",
  locked
);
pref("browser.backup.template.fallback-download.esr", "about:blank", locked);
