import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The application root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>B2B Portal</h1>
      <p>Welcome to the B2B Portal.</p>
    </main>
  </StrictMode>,
);
