import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { initWhatsapp } from "./whatsapp";

export function registerRoutes(app: Express): Server {
  const httpServer = createServer(app);

  // Initialize WhatsApp client
  initWhatsapp();
  
  return httpServer;
}
