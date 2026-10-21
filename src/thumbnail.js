import { parseHTML } from "linkedom";
import { renderDeck } from "./deck.js";

// This document intentionally uses no presentation bridge or imported JavaScript.
// The only executable content is the shipped text/object geometry renderer.
export function renderThumbnail(html, state, slideId, nonce) {
  if (!state.order.includes(slideId)) throw new Error("알 수 없는 슬라이드입니다.");
  const { document } = parseHTML(renderDeck(html, state));
  const selected = [...document.querySelectorAll("[data-sd-slide]")].find(slide => slide.getAttribute("data-sd-slide") === slideId);
  if (!selected) throw new Error("슬라이드를 찾을 수 없습니다.");
  for (const node of document.querySelectorAll("script,iframe,frame,frameset,object,embed,base,meta[http-equiv],.notes,canvas,animate,animateMotion,animateTransform,set")) node.remove();
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (/^on/.test(name) || ["nonce", "srcdoc", "autofocus", "contenteditable", "autoplay"].includes(name) ||
        ["href", "xlink:href", "src", "action", "formaction"].includes(name) && /^\s*(javascript|vbscript):/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
    if (element.localName === "link" && element.getAttribute("rel")?.toLowerCase() !== "stylesheet") element.remove();
  }
  for (const stylesheet of document.querySelectorAll("style,link[rel=stylesheet]")) document.head.append(stylesheet);
  // Retain the selected slide's ancestor chain for source CSS selectors, but remove
  // all sibling content (other slides, navigation, global canvas and HUD layers).
  for (let child = selected, parent = selected.parentElement; parent && parent !== document.documentElement; child = parent, parent = parent.parentElement) {
    for (const sibling of [...parent.childNodes]) {
      if (sibling === child) continue;
      if (sibling.nodeType === 1 && sibling.matches("style,link[rel=stylesheet]")) document.head.append(sibling);
      else sibling.remove();
    }
  }
  const force = (node, properties) => {
    node.removeAttribute("hidden"); node.removeAttribute("inert"); node.setAttribute("aria-hidden", "false");
    for (const [property, value] of Object.entries(properties)) node.style.setProperty(property, value, "important");
  };
  for (let node = selected.parentElement; node; node = node.parentElement) force(node, {
    position: "relative", display: "block", width: "1920px", height: "1080px", "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none",
    margin: "0", padding: "0", border: "0", inset: "auto", transform: "none", translate: "none", rotate: "none", scale: "none", zoom: "1", visibility: "visible", opacity: "1", overflow: "hidden",
  });
  selected.classList.add("active");
  if (selected.style.getPropertyValue("display") === "none") selected.style.removeProperty("display");
  force(selected, {
    position: "absolute", left: "0", top: "0", right: "auto", bottom: "auto", width: "1920px", height: "1080px", "min-width": "0", "min-height": "0", "max-width": "none", "max-height": "none",
    margin: "0", "box-sizing": "border-box", transform: "none", translate: "none", rotate: "none", scale: "none", zoom: "1", visibility: "visible", opacity: "1", overflow: "hidden",
  });
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html,body{pointer-events:none!important}.notes{display:none!important}";
  document.head.append(style);
  for (const name of ["text-model.js", "text-editor.js", "object-model.js"]) {
    const script = document.createElement("script");
    script.setAttribute("nonce", nonce); script.setAttribute("src", "/_studio/" + name); document.body.append(script);
  }
  const script = document.createElement("script");
  script.setAttribute("nonce", nonce);
  script.textContent = `(()=>{const slide=document.querySelector('[data-sd-slide]');if(getComputedStyle(slide).display==='none')slide.style.setProperty('display','block','important');const refresh=()=>globalThis.SDObjects.refresh(slide);refresh();Promise.all([document.fonts.ready,...[...document.images].map(image=>image.decode().catch(()=>{}))]).then(()=>{refresh();globalThis.__sdThumbnail=true;});})();`;
  document.body.append(script);
  return document.toString();
}
