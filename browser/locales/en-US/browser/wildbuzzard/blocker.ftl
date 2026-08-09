# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
# Derived from BrowserWorks/l10n commit cc8b91caafb0022b5874358c9a90a155ab74bc79.

## Ad blocking

wildbuzzard-blocker-header = Ad Blocking

wildbuzzard-blocker-intro-description = Blocks ads, tracking scripts, and other unwanted requests for faster page loads and fewer distractions.

wildbuzzard-blocker-setting-on =
    .label = On

wildbuzzard-blocker-setting-on-summary = Blocks ads and trackers with minimal impact on page loading.

wildbuzzard-blocker-setting-on-description = WildBuzzard blocks the following:

wildbuzzard-blocker-blocks-ads = Ads and ad network requests

wildbuzzard-blocker-blocks-tracking = Tracking scripts and pixels

wildbuzzard-blocker-blocks-annoyances = Nuisance popups and overlays (with annoyance lists enabled)

wildbuzzard-blocker-setting-off =
    .label = Off

wildbuzzard-blocker-setting-off-description = No ads or trackers are blocked by WildBuzzard. Third-party extensions can still block content independently.

wildbuzzard-blocker-manage-filter-lists =
    .label = Manage Filter Lists…

wildbuzzard-blocker-custom-filter-lists =
    .label = Custom Filter Lists…

wildbuzzard-blocker-filter-lists-window =
    .title = Ad blocking filter lists

wildbuzzard-blocker-filter-lists-dialog =
    .buttonlabelaccept = Save Changes
    .buttonaccesskeyaccept = S

wildbuzzard-blocker-filter-lists-description =
    .value = Choose which filter lists are active.

# Variables:
#   $activeCount (Number) - Number of enabled filter lists.
#   $totalCount (Number) - Total number of available filter lists.
wildbuzzard-blocker-filter-lists-active-count =
    .value = { $activeCount } active of { $totalCount }

wildbuzzard-blocker-filter-lists-column-enabled =
    .label = Enabled

wildbuzzard-blocker-filter-lists-column-name =
    .label = Filter List

wildbuzzard-blocker-filter-lists-column-category =
    .label = Category

wildbuzzard-blocker-filter-lists-enable =
    .label = Enable

wildbuzzard-blocker-filter-lists-disable =
    .label = Disable

wildbuzzard-blocker-extension-detected = WildBuzzard now has built-in ad blocking. You can review your setup in settings.

wildbuzzard-blocker-extension-detected-learn-more =
    .label = Learn more

wildbuzzard-blocker-extension-detected-dismiss =
    .label = Don’t show again

wildbuzzard-blocker-extension-install-warning = WildBuzzard already has a built-in ad blocker. Running two ad blockers can cause pages to break or load slowly.

wildbuzzard-blocker-extension-install-got-it =
    .label = Got it

wildbuzzard-blocker-extension-install-learn-more =
    .label = Learn more

# Variables:
#   $extensionName (String) - Name of the third-party extension controlling ad blocking.
wildbuzzard-blocker-third-party-notice-description = { $extensionName } is also blocking ads. Running two ad blockers can cause issues.

permissions-exceptions-wildbuzzard-blocker-window2 =
    .title = Exceptions for Ad Blocking
    .style = { permissions-window2.style }

permissions-exceptions-manage-wildbuzzard-blocker-desc = You can specify which websites have ad blocking turned off. Type the exact address of the site you want to manage and then click Add Exception.

wildbuzzard-blocker-toolbar-button =
    .label = Ad blocking
    .tooltiptext = Ad blocking

wildbuzzard-agent-toolbar-button =
    .label = Agent
    .tooltiptext = Open Agent

wildbuzzard-torrent-toolbar-button =
    .label = Torrents
    .tooltiptext = Open Torrents

wildbuzzard-blocker-panel-not-available = Not available on this page

wildbuzzard-blocker-panel-toggle =
    .label = Ad blocking on this site
    .description = Block ads and trackers on this site.

wildbuzzard-blocker-panel-disabled = Ad blocking is off

wildbuzzard-blocker-panel-site-excepted = Ads allowed on this site

# Variables:
#   $count (Number) - Number of ads blocked on this site.
wildbuzzard-blocker-stats =
    { $count ->
        [one] { $count } ad blocked on this site
       *[other] { $count } ads blocked on this site
    }

wildbuzzard-blocker-panel-settings-button = Ad blocking settings

wildbuzzard-blocker-show-badge-pref =
    .label = Show blocked count on toolbar button

wildbuzzard-blocker-filter-lists-category-core = Default

wildbuzzard-blocker-filter-lists-category-privacy = Privacy

wildbuzzard-blocker-filter-lists-category-annoyances = Annoyances

wildbuzzard-blocker-filter-lists-category-optional = Optional

wildbuzzard-blocker-filter-lists-category-regional = Regional

wildbuzzard-blocker-filter-lists-search =
    .placeholder = Search filter lists…

wildbuzzard-blocker-filter-lists-empty-state = No filter lists available.

wildbuzzard-blocker-filter-lists-refresh-now =
    .label = Refresh Now

# Variables:
#   $date (String) - Human-readable date/time of the last successful list update.
wildbuzzard-blocker-filter-lists-last-updated = Updated { $date }

wildbuzzard-blocker-filter-lists-never-updated =
    .value = Not yet updated

# Variables:
#   $date (String) - Human-readable date/time of the next scheduled list update.
wildbuzzard-blocker-filter-lists-next-refresh =
    .value = Next refresh: { $date }

wildbuzzard-blocker-filter-lists-next-refresh-unknown =
    .value = Next refresh: unknown

wildbuzzard-blocker-custom-filter-lists-window =
    .title = Custom Filter Lists

wildbuzzard-blocker-custom-filter-lists-dialog =
    .buttonlabelaccept = Save Changes
    .buttonaccesskeyaccept = S

wildbuzzard-blocker-custom-filter-lists-description = Add URLs of custom filter lists. Lists will be fetched and applied alongside built-in filters.

wildbuzzard-blocker-filter-lists-custom-heading =
    .value = Custom Filter Lists

wildbuzzard-blocker-filter-lists-custom-input =
    .placeholder = Enter filter list URL…

wildbuzzard-blocker-filter-lists-custom-url-label =
    .value = Filter list URL

wildbuzzard-blocker-filter-lists-custom-col =
    .label = URL

wildbuzzard-blocker-filter-lists-custom-add =
    .label = Add

wildbuzzard-blocker-filter-lists-custom-remove =
    .label = Remove

wildbuzzard-blocker-filter-lists-custom-remove-all =
    .label = Remove All

wildbuzzard-blocker-filter-lists-custom-empty =
    .value = No custom filter lists added.

wildbuzzard-blocker-custom-filters =
    .label = My Filters…

wildbuzzard-blocker-custom-filters-window =
    .title = My Filters

wildbuzzard-blocker-custom-filters-dialog =
    .buttonlabelaccept = Save Changes
    .buttonaccesskeyaccept = S

wildbuzzard-blocker-custom-filters-description = Add your own ad blocking rules. These use standard uBlock Origin filter syntax and are applied alongside your enabled filter lists.

wildbuzzard-blocker-custom-filters-empty =
    .value = No custom filters.

# Variables:
#   $count (Number) - Number of custom filters currently configured.
wildbuzzard-blocker-custom-filters-status =
    { $count ->
        [0] No custom filters.
        [one] 1 custom filter.
       *[other] { $count } custom filters.
    }

wildbuzzard-blocker-custom-filters-status-unsaved = Unsaved changes.

wildbuzzard-blocker-custom-filters-import =
    .label = Import…

wildbuzzard-blocker-custom-filters-export =
    .label = Export…

wildbuzzard-blocker-custom-filters-load-error-title = Load failed

wildbuzzard-blocker-custom-filters-load-error = Custom filters could not be loaded.

wildbuzzard-blocker-custom-filters-save-error-title = Save failed

wildbuzzard-blocker-custom-filters-save-error = Custom filters could not be saved.

wildbuzzard-blocker-custom-filters-import-error-title = Import failed

wildbuzzard-blocker-custom-filters-import-error = The selected file could not be imported.

wildbuzzard-blocker-custom-filters-export-error-title = Export failed

wildbuzzard-blocker-custom-filters-export-error = Custom filters could not be exported.

wildbuzzard-blocker-custom-filters-import-picker-title = Import custom filters

wildbuzzard-blocker-custom-filters-export-picker-title = Export custom filters

wildbuzzard-blocker-custom-filters-import-replace-title = Replace current filters?

wildbuzzard-blocker-custom-filters-import-replace-message = Importing will replace everything currently in the editor.

wildbuzzard-blocker-extension-fallback-name-this = this extension

wildbuzzard-blocker-extension-fallback-name-your = your extension

wildbuzzard-blocker-spotlight-title = WildBuzzard now includes ad blocking

# Variables:
#   $extensionName (String) - Name of the user’s existing ad-blocking extension.
wildbuzzard-blocker-spotlight-subtitle = We noticed you have { $extensionName } installed. WildBuzzard also includes a built-in blocker. Choose the setup you prefer.

wildbuzzard-blocker-spotlight-primary-button = Keep my current setup

wildbuzzard-blocker-spotlight-secondary-button = Review settings

wildbuzzard-blocker-prompt-title = WildBuzzard ad blocking

# Variables:
#   $extensionName (String) - Name of the extension that conflicts with built-in ad blocking.
wildbuzzard-blocker-reenable-conflict-message = Running both WildBuzzard ad blocking and “{ $extensionName }” can cause pages to break. Which would you like to keep?

wildbuzzard-blocker-reenable-use-built-in = Use built-in blocker

wildbuzzard-blocker-reenable-keep-extension = Keep extension blocker

wildbuzzard-blocker-extension-install-manage-settings = You can manage ad blocking in Settings > Ad Blocking.

wildbuzzard-blocker-extension-install-anyway = Install anyway

wildbuzzard-blocker-extension-install-keep-built-in = Keep using built-in blocker

pane-wildbuzzard-blocker-title = Ad Blocking
    .title = { pane-wildbuzzard-blocker-title }

wildbuzzard-blocker-pane-header =
    .heading = Ad Blocking

wildbuzzard-blocker-group =
    .label = Ad blocking
    .description = Blocks ads, tracking scripts, and other unwanted requests for faster page loads and fewer distractions.

wildbuzzard-blocker-enabled-toggle =
    .label = Block ads and trackers
    .description = Blocks ads and trackers with minimal impact on page loading.

# Variables:
#   $extensionName (String) - Name of the third-party extension that also blocks ads.
wildbuzzard-blocker-extension-notice =
    .message = { $extensionName } is also blocking ads. Running two ad blockers can cause issues.

wildbuzzard-blocker-lists-group =
    .label = Filter lists

wildbuzzard-blocker-manage-lists-button =
    .label = Manage filter lists

wildbuzzard-blocker-custom-lists-button =
    .label = Custom filter lists

wildbuzzard-blocker-my-filters-button =
    .label = My filters

wildbuzzard-blocker-exceptions-group =
    .label = Exceptions

wildbuzzard-blocker-exceptions-button =
    .label = Manage exceptions

wildbuzzard-blocked-page-title = WildBuzzard blocked this page

wildbuzzard-blocked-page-heading = WildBuzzard blocked this page

wildbuzzard-blocked-page-description = This page was blocked by an ad blocking filter rule.

wildbuzzard-blocked-page-details =
    .aria-label = Blocked page details

wildbuzzard-blocked-page-blocked-url-label = Blocked URL

wildbuzzard-blocked-page-matched-rule-label = Matched rule

wildbuzzard-blocked-page-unavailable = Unavailable

wildbuzzard-blocked-page-hint = “Load anyway” will temporarily allow this site for the rest of your session.

wildbuzzard-blocked-page-go-back = Go back

wildbuzzard-blocked-page-load-anyway = Load anyway
