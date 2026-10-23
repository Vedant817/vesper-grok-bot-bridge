# Community overview

Open-source diagrams for introducing Vesper. They describe the same architecture as the [Mermaid system design](../../docs/SYSTEM_DESIGN.md) and the [two community templates](../README.md).

| Diagram | Image | Editable scene |
| --- | --- | --- |
| Cloud reasoning, local code, one approved door | [PNG](01-cloud-local-bridge.png) | [Excalidraw](01-cloud-local-bridge.excalidraw) |
| Two routes, two credentials | [PNG](02-two-routes.png) | [Excalidraw](02-two-routes.excalidraw) |
| Supervision loop | [PNG](03-supervisor-loop.png) | [Excalidraw](03-supervisor-loop.excalidraw) |

The `*-elements.json` files are the element lists used to draw each scene. Regenerate a PNG from a saved scene with the Excalidraw canvas CLI:

```powershell
npx -y mcp-excalidraw-server render 01-cloud-local-bridge.excalidraw --out 01-cloud-local-bridge.png --scale 2
```

These files document the project. They do not include a personal endpoint, credential, or account.
