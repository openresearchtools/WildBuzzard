# Pristine Pi source

`upstream/` is the complete, unmodified Git tree for the source commit recorded
in `UPSTREAM.toml`. It is retained to build the independently packaged Buzzard
Agent runtime and to satisfy attribution and source-availability requirements.

Do not put Wild Buzzard branding or integration changes in `upstream/`.
Downstream transformations belong to `wildbuzzard/components/buzzard-agent`.

The older `@earendil-works/pi-ai` 0.83.0 declaration in the web-access extension
is not the runtime source version. The installed runtime lock selects 0.84.1,
and npm metadata for that version identifies the vendored commit exactly.
