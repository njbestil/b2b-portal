import express from "express";
import {
  errorHandler,
  notFoundHandler,
  requestIdMiddleware,
  sendSuccess,
} from "./http.js";

export function createApp() {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());

  app.get("/", (_request, response) => {
    sendSuccess(response, { service: "b2b-portal-api" });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
