import express from "express";

const app = express();

app.get("/", (_request, response) => {
  response.json({ service: "b2b-portal-mock-erp" });
});

app.listen(3001, "127.0.0.1");
