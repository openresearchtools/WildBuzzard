# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Branding lives outside browser/, so inherit the application ID explicitly
# when locale resources are assembled into a langpack during `mach package`.
XPI_ROOT_APPID = $(MOZ_APP_ID)
