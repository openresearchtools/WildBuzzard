#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
WILDBUZZARD_ID = "{648cc8ea-a8a6-59ec-b7e7-3ddc7e685961}"
FIREFOX_ID = "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}"


def source(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


class ProductNamespaceIsolationTests(unittest.TestCase):
    def test_build_identity_and_update_channels_are_isolated(self):
        browser_configure = source("browser/moz.configure")
        product_configure = source("wildbuzzard/moz.configure")
        components = source("browser/components/BrowserComponents.manifest")
        toolkit_configure = source("toolkit/moz.configure")

        self.assertIn('imply_option("MOZ_PROFILE_MIGRATOR", False)', browser_configure)
        self.assertIn(
            f'imply_option("MOZ_APP_ID", "{WILDBUZZARD_ID}")', browser_configure
        )
        self.assertNotIn(FIREFOX_ID, browser_configure)
        self.assertIn(WILDBUZZARD_ID, components)
        self.assertNotIn(FIREFOX_ID, components)
        self.assertIn('imply_option("MOZ_APP_UA_NAME", "Firefox")', product_configure)
        self.assertIn(
            'imply_option("MOZ_APP_REMOTINGNAME", "org.wildbuzzard.WildBuzzard")',
            product_configure,
        )
        self.assertNotIn("MOZ_APP_PROFILE", product_configure)
        self.assertIn('imply_option("--enable-updater", False)', browser_configure)
        self.assertIn(
            'imply_option("--enable-crashreporter", False)', product_configure
        )
        self.assertNotIn("--allow-addon-sideload", product_configure)
        self.assertIn(
            '@depends(milestone, "MOZ_APP_VENDOR")', toolkit_configure
        )
        self.assertIn('app_vendor[0] != "WildBuzzard"', toolkit_configure)
        self.assertIn(
            'imply_option("--enable-system-extension-dirs", False)',
            product_configure,
        )
        self.assertIn('set_define("MOZ_WILDBUZZARD", True)', product_configure)
        self.assertIn('return "wildbuzzard"', toolkit_configure)

    def test_firefox_profile_import_is_not_registered_or_packaged(self):
        product_components = source("wildbuzzard/browser/components/moz.build")
        onboarding = source(
            "wildbuzzard/browser/components/onboarding/WildBuzzardOnboarding.sys.mjs"
        )
        migration_build = source("browser/components/migration/moz.build")
        migration_utils = source("browser/components/migration/MigrationUtils.sys.mjs")

        self.assertNotIn('"migration"', product_components)
        self.assertNotIn("firefox-import", onboarding)
        self.assertNotIn("AW_WILDBUZZARD_IMPORT", onboarding)
        self.assertIn('if CONFIG["MOZ_PROFILE_MIGRATOR"]:', migration_build)
        for module in (
            "FirefoxImportMigrator.sys.mjs",
            "FirefoxProfileLoginCrypto.sys.mjs",
            "FirefoxProfileMigrator.sys.mjs",
            "FirefoxSelectableProfileMigrator.sys.mjs",
        ):
            self.assertGreater(
                migration_build.index(module),
                migration_build.index('if CONFIG["MOZ_PROFILE_MIGRATOR"]:'),
            )
        self.assertIn("AppConstants.MOZ_PROFILE_MIGRATOR", migration_utils)
        self.assertFalse(
            (ROOT / "wildbuzzard/browser/components/migration/moz.build").exists()
        )

    def test_linux_native_manifest_and_profile_roots_are_product_only(self):
        manifests = source("toolkit/components/extensions/NativeManifests.sys.mjs")
        provider = source("toolkit/xre/nsXREDirProvider.cpp")

        self.assertNotIn("COMPAT_DIR_NAMES", manifests)
        self.assertNotIn("getCompatibilityPath", manifests)
        self.assertNotIn(".mozilla", manifests)
        self.assertIn("IsWildBuzzardApp()", provider)
        self.assertIn('"/usr/lib/wildbuzzard"_ns', provider)
        self.assertIn('"/usr/share/wildbuzzard/extensions"', provider)
        self.assertIn("GetUserAppDataDirectory(getter_AddRefs(file))", provider)
        self.assertIn(
            "ProductDirectoriesDoNotUseMozillaRoots",
            source("toolkit/tests/gtest/TestXREAppDir.cpp"),
        )

    def test_remoting_desktop_and_control_state_are_product_only(self):
        remote_client = source("toolkit/components/remote/nsDBusRemoteClient.cpp")
        remote_server = source("toolkit/components/remote/nsDBusRemoteServer.cpp")
        gnome = source("browser/components/shell/nsGNOMEShellDBusHelper.cpp")
        gtk_dbus = source("widget/gtk/DBusService.cpp")
        gtk_portal = source("widget/gtk/WidgetUtilsGtk.cpp")
        wayland = source("widget/gtk/nsWindowWayland.cpp")
        appimage_desktop = source("wildbuzzard/packaging/appimage/wildbuzzard.desktop")
        appimage_script = source("wildbuzzard/scripts/package-appimage.sh")
        browser_control = source(
            "browser/components/wildbuzzardcontrol/WildBuzzardControlStartup.sys.mjs"
        )
        cli_control = source(
            "wildbuzzard/components/wildbuzzard-cli/runner/src/main.rs"
        )

        for implementation in (
            remote_client,
            remote_server,
            gnome,
            gtk_dbus,
            gtk_portal,
            wayland,
        ):
            self.assertIn("org.wildbuzzard", implementation)
        for implementation in (remote_client, remote_server, gnome, gtk_dbus):
            self.assertIn("/org/wildbuzzard", implementation)
        self.assertIn("Icon=org.wildbuzzard.WildBuzzard", appimage_desktop)
        self.assertIn("org.wildbuzzard.WildBuzzard.desktop", appimage_script)
        self.assertIn('Services.env.get("XDG_STATE_HOME")', browser_control)
        self.assertNotIn('Services.env.get("XDG_DATA_HOME")', browser_control)
        self.assertIn('env::var_os("XDG_STATE_HOME")', cli_control)
        self.assertNotIn('env::var_os("XDG_DATA_HOME")', cli_control)

    def test_release_payload_enforces_product_identity(self):
        verifier = source("wildbuzzard/scripts/verify_browser_legal_payload.py")
        release_manifest = source("wildbuzzard/ci/create-release-manifest.py")

        self.assertIn(WILDBUZZARD_ID, verifier)
        self.assertIn('"Vendor": "WildBuzzard"', verifier)
        self.assertIn('"RemotingName": "org.wildbuzzard.WildBuzzard"', verifier)
        self.assertIn('parser.has_option("App", "Profile")', verifier)
        self.assertIn('parser.has_option("XRE", "EnableProfileMigrator")', verifier)
        self.assertIn('("AppUpdate", "Crash Reporter")', verifier)
        self.assertIn(
            "openresearchtools <229047507+openresearchtools@users.noreply.github.com>",
            release_manifest,
        )
        self.assertIn("maintainer != EXPECTED_MAINTAINER", release_manifest)


if __name__ == "__main__":
    unittest.main()
