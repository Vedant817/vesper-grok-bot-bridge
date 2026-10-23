# Architecture diagrams

Editable Mermaid diagrams and shareable SVG exports for Vesper Grok Bot Bridge.

| Diagram | Mermaid source | SVG export |
| --- | --- | --- |
| System overview and the two supervision routes | [01-system-overview.mmd](01-system-overview.mmd) | [SVG](01-system-overview.svg) |
| Standalone layers, networking and trust boundaries | [02-standalone-layers-network.mmd](02-standalone-layers-network.mmd) | [SVG](02-standalone-layers-network.svg) |
| OAuth enrollment and local owner approval | [03-oauth-enrollment.mmd](03-oauth-enrollment.mmd) | [SVG](03-oauth-enrollment.svg) |
| Task lifecycle and verification gate | [04-task-verification-sequence.mmd](04-task-verification-sequence.mmd) | [SVG](04-task-verification-sequence.svg) |
| Optional T3 integration and legacy supervisor | [05-optional-and-legacy.mmd](05-optional-and-legacy.mmd) | [SVG](05-optional-and-legacy.svg) |

The [full system-design guide](../SYSTEM_DESIGN.md) renders all five diagrams on GitHub and includes the technology inventory, source map, community overview and interview notes. Shareable Excalidraw exports live in [community/overview](../../community/overview). The [repository README](../../README.md#system-architecture) displays the overview directly.

Download [explorer.html](explorer.html) and open it locally for an offline viewer with diagram tabs, zoom, copyable Mermaid and SVG downloads. GitHub displays the HTML source rather than running the viewer.

The `.mmd` files are the editable originals. When a diagram changes, update its matching Mermaid block in the system-design guide, regenerate the SVG and offline viewer, and keep the README overview synchronized with `01-system-overview.mmd`.
