import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import "./enhancements.css";
import "./audio.css";
import "./video.css";
import "./scenes.css";
import "./milestone12.css";
import { App } from "./App.js";

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
