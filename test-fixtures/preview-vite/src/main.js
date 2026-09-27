import { label } from "./label.js";

document.querySelector("#app").textContent = label;
if (import.meta.hot) {
  import.meta.hot.accept("./label.js", (module) => {
    document.querySelector("#app").textContent = module.label;
    document.body.dataset.hmrUpdates = String(Number(document.body.dataset.hmrUpdates ?? 0) + 1);
  });
}
