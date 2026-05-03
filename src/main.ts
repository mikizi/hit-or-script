import { registerSW } from "virtual:pwa-register";
import "./game.css";
import { bootGame } from "./game";

registerSW({ immediate: true });

bootGame();
