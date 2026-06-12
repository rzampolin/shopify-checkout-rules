import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>CheckoutRules</h1>
        <p className={styles.text}>
          Replace Shopify Scripts with merchant-defined, explicitly-ordered
          discount rules — powered by a single Discount Function.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Rule builder</strong>. Create conditions and actions, then
            drag rules into the exact priority order you need.
          </li>
          <li>
            <strong>Preview mode</strong>. Test any cart against your ruleset
            before activating — powered by the same engine as the live Function.
          </li>
          <li>
            <strong>Instant updates</strong>. Rule changes take effect
            immediately; no redeployment required.
          </li>
        </ul>
      </div>
    </div>
  );
}
