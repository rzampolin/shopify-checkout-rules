// Vite asset-URL query suffix — not declared by @remix-run/dev but required by
// the Polaris CSS import in app/routes/app.tsx:
//   import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
declare module "*?url" {
  const src: string;
  export default src;
}
