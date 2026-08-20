#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
from pathlib import Path


REPLACEMENTS = {
    "packages/coding-agent/src/cli.ts": [
        ('process.env.PI_CODING_AGENT = "true";', 'process.env.BUZZARD_AGENT = "true";'),
        ('process.env.AI_AGENT = "pi";', 'process.env.AI_AGENT = "buzzard-agent";'),
    ],
    "packages/coding-agent/src/rpc-entry.ts": [
        ('process.env.PI_CODING_AGENT = "true";', 'process.env.BUZZARD_AGENT = "true";'),
        ('process.env.AI_AGENT = "pi";', 'process.env.AI_AGENT = "buzzard-agent";'),
    ],
    "packages/coding-agent/src/main.ts": [
        (
            'const EXTENSION_LOAD_FAILURE_HINT = \'Hint: Start without extensions using "pi -ne".\';',
            'const EXTENSION_LOAD_FAILURE_HINT = \'Hint: Start without extensions using "buzzard-agent -ne".\';',
        ),
        (
            'args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE)',
            'args.includes("--offline") || isTruthyEnvFlag(process.env.BUZZARD_AGENT_OFFLINE) || isTruthyEnvFlag(process.env.PI_OFFLINE)',
        ),
        (
            'const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);',
            'const startupBenchmark = isTruthyEnvFlag(process.env.BUZZARD_AGENT_STARTUP_BENCHMARK);',
        ),
        (
            '"Error: PI_STARTUP_BENCHMARK only supports interactive mode"',
            '"Error: BUZZARD_AGENT_STARTUP_BENCHMARK only supports interactive mode"',
        ),
    ],
    "packages/coding-agent/src/config.ts": [
        ('export const APP_NAME: string = piConfigName || "pi";', 'export const APP_NAME: string = piConfigName || "buzzard-agent";'),
        ('export const APP_TITLE: string = piConfigName ? APP_NAME : "π";', 'export const APP_TITLE: string = piConfigName ? APP_NAME : "Buzzard Agent";'),
        ('export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";', 'export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".buzzard-agent";'),
        (
            'export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;\nexport const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;',
            'export const ENV_AGENT_DIR = "BUZZARD_AGENT_DIR";\nexport const ENV_SESSION_DIR = "BUZZARD_AGENT_SESSION_DIR";',
        ),
        ('const envDir = process.env.PI_PACKAGE_DIR;', 'const envDir = process.env.BUZZARD_AGENT_PACKAGE_DIR || process.env.PI_PACKAGE_DIR;'),
        ('const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";', 'const DEFAULT_SHARE_VIEWER_URL = "";'),
        (
            'const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;\n\treturn `${baseUrl}#${gistId}`;',
            'const baseUrl = process.env.BUZZARD_AGENT_SHARE_VIEWER_URL || process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;\n\tif (!baseUrl) throw new Error("Set BUZZARD_AGENT_SHARE_VIEWER_URL before sharing a session");\n\treturn `${baseUrl}#${gistId}`;',
        ),
    ],
    "packages/coding-agent/src/utils/pi-user-agent.ts": [
        ('return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;', 'return `buzzard-agent/${version} (${process.platform}; ${runtime}; ${process.arch})`;'),
    ],
    "packages/coding-agent/src/core/provider-attribution.ts": [
        ('"HTTP-Referer": "https://pi.dev",', '"HTTP-Referer": "https://github.com/openresearchtools/wildbuzzard",'),
        ('"X-OpenRouter-Title": "pi",', '"X-OpenRouter-Title": "Buzzard Agent",'),
        ('"X-BILLING-INVOKE-ORIGIN": "Pi",', '"X-BILLING-INVOKE-ORIGIN": "BuzzardAgent",'),
        ('"User-Agent": "pi-coding-agent",', '"User-Agent": "buzzard-agent",'),
        ('return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };', 'return { "x-opencode-session": sessionId, "x-opencode-client": "buzzard-agent" };'),
    ],
    "packages/coding-agent/src/core/system-prompt.ts": [
        (
            "You are an expert coding assistant operating inside pi, a coding agent harness.",
            "You are an expert coding assistant operating inside Buzzard Agent, a coding agent harness.",
        ),
        ("Pi documentation (read only when the user asks about pi itself,", "Upstream agent documentation (read only when the user asks about Buzzard Agent,"),
        ("When reading pi docs or examples", "When reading the bundled upstream docs or examples"),
        ("When asked about:", "When asked about Buzzard Agent capabilities:"),
        ("pi packages (docs/packages.md)", "agent packages (docs/packages.md)"),
        ("When working on pi topics", "When working on Buzzard Agent topics"),
        ("Always read pi .md files", "Always read the relevant .md files"),
    ],
    "packages/coding-agent/src/cli/auth-command.ts": [
        ("pi auth", "buzzard-agent auth", 9),
    ],
    "packages/coding-agent/src/cli/args.ts": [
        (
            "${APP_NAME} update [source|self|pi]   Update pi, extensions, or model catalogs",
            "${APP_NAME} update [source]           Update extensions or model catalogs; use apt for the agent",
        ),
        ("(same as PI_OFFLINE=1)", "(same as BUZZARD_AGENT_OFFLINE=1)"),
        ('  PI_PACKAGE_DIR                   - Override package directory (for Nix/Guix store paths)\n  PI_OFFLINE                       - Disable startup network operations when set to 1/true/yes\n  PI_TELEMETRY                     - Override install telemetry when set to 1/true/yes or 0/false/no\n  PI_SHARE_VIEWER_URL              - Base URL for /share command (default: https://pi.dev/session/)',
         '  BUZZARD_AGENT_PACKAGE_DIR        - Override package directory (for Nix/Guix store paths)\n  BUZZARD_AGENT_OFFLINE            - Disable startup network operations when set to 1/true/yes\n  BUZZARD_AGENT_SHARE_VIEWER_URL   - Base URL for the /share command'),
    ],
    "packages/coding-agent/src/package-manager-cli.ts": [
        ("\tdetectInstallMethod,\n", ""),
        ("\tgetSelfUpdateCommand,\n", ""),
        ("[source|self|pi]", "[source|extensions]"),
        ("Update pi, installed packages, or model catalogs.", "Update installed packages or model catalogs. Agent updates are managed by apt."),
        ("Update pi only (default when no target is given)", "Agent updates are managed by apt"),
        ("Update pi and installed packages", "Update installed packages; agent updates are managed by apt"),
        ("Reinstall pi even if the current version is latest", "Force the selected extension update"),
        ("Update pi and all extensions", "Update all extensions"),
        ("Update pi only (self works as alias to pi)", "Agent updates are managed by apt"),
        ("Update pi only", "Agent updates are managed by apt"),
        ("${APP_NAME} update pi             Agent updates are managed by apt", "${APP_NAME} update buzzard-agent  Agent updates are managed by apt"),
        ('const sourceIsSelf = source === "self" || source === "pi";', 'const sourceIsSelf = source === "self" || source === "buzzard-agent";'),
        ('console.error(`Location of pi executable: ${entrypoint}`);', 'console.error(`Location of buzzard-agent executable: ${entrypoint}`);'),
        ("function printSelfUpdateUnavailable(", "function _printSelfUpdateUnavailable("),
        ("function printSelfUpdateFallback(", "function _printSelfUpdateFallback("),
        ("function printPnpmSelfUpdateMetadataHint(", "function _printPnpmSelfUpdateMetadataHint("),
        ("function printSelfUpdateNote(", "function _printSelfUpdateNote("),
        ("async function getSelfUpdatePlan(", "async function _getSelfUpdatePlan("),
        ("async function runSelfUpdate(", "async function _runSelfUpdate("),
        ("function prepareWindowsNpmSelfUpdate(", "function _prepareWindowsNpmSelfUpdate("),
        ("const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;", "const _selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;"),
    ],
    "packages/coding-agent/src/modes/interactive/interactive-mode.ts": [
        ("Pi can explain its own features and look up its docs. Ask it how to use or extend Pi.", "Buzzard Agent can explain its own features and inspect its bundled upstream documentation."),
        ("Pi works best with csi-u.", "Buzzard Agent works best with csi-u."),
        ("then restart pi.", "then restart Buzzard Agent."),
        ('console.error("pi exiting due to uncaughtException:");', 'console.error("buzzard-agent exiting due to uncaughtException:");'),
        ("Restart pi for this to take effect.", "Restart Buzzard Agent for this to take effect."),
        ("is configured outside pi.", "is configured outside Buzzard Agent."),
        ('const fileName = `pi-clipboard-${crypto.randomUUID()}.${ext}`;', 'const fileName = `buzzard-agent-clipboard-${crypto.randomUUID()}.${ext}`;'),
    ],
    "packages/coding-agent/src/modes/interactive/components/earendil-announcement.ts": [
        ('"pi has joined Earendil"', '"Buzzard Agent uses the Earendil agent engine"'),
    ],
    "packages/coding-agent/src/modes/interactive/components/first-time-setup.ts": [
        ("bugs within Pi.", "bugs within Buzzard Agent."),
    ],
    "packages/coding-agent/src/core/session-manager.ts": [
        ("not a valid pi session", "not a valid Buzzard Agent session"),
    ],
    "packages/coding-agent/src/core/bash-executor.ts": [
        ("`pi-bash-${id}.log`", "`buzzard-agent-bash-${id}.log`"),
    ],
    "packages/coding-agent/src/core/tools/output-accumulator.ts": [
        ('"pi-output"', '"buzzard-agent-output"'),
    ],
    "packages/coding-agent/src/core/tools/bash.ts": [
        ('tempFilePrefix: "pi-bash"', 'tempFilePrefix: "buzzard-agent-bash"'),
    ],
}


def replace(path: Path, old: str, new: str, expected: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise ValueError(f"expected {expected} occurrence(s) in {path}: {old!r}; found {count}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def replace_self_update(root: Path) -> None:
    path = root / "packages/coding-agent/src/package-manager-cli.ts"
    text = path.read_text(encoding="utf-8")
    start_marker = "\t\t\t\tif (updateTargetIncludesSelf(target)) {"
    final_marker = "\t\t\t\t\tconsole.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));"
    start = text.index(start_marker)
    final = text.index(final_marker, start)
    end = text.index("\n\t\t\t\t}", final) + len("\n\t\t\t\t}")
    replacement = (
        "\t\t\t\tif (updateTargetIncludesSelf(target)) {\n"
        "\t\t\t\t\tconsole.error(chalk.yellow(\"Buzzard Agent is managed by Debian packages. Run apt update and apt install buzzard-agent.\"));\n"
        "\t\t\t\t\tif (target.type === \"self\") process.exitCode = 1;\n"
        "\t\t\t\t}"
    )
    path.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    root = args.source.resolve()
    for relative, replacements in REPLACEMENTS.items():
        for replacement in replacements:
            replace(root / relative, *replacement)
    replace_self_update(root)


if __name__ == "__main__":
    main()
