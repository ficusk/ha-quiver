// Maps an entity to a Lucide icon by domain, refined by HA's device_class
// where it carries real type info (a media_player that's a speaker vs a TV,
// a cover that's a shade vs a garage door, a sensor measuring temperature vs
// power). device_class rides in the entity's attributes, so this needs no
// extra plumbing — it's the same data HA's own frontend keys its icons off.

import {
  Activity,
  Battery,
  BatteryLow,
  Bell,
  BellRing,
  Blinds,
  Cctv,
  Circle,
  CircleDot,
  Clock,
  DoorClosed,
  DoorOpen,
  Droplet,
  Droplets,
  Fan,
  Flame,
  Gauge,
  Lightbulb,
  List,
  Lock,
  LockOpen,
  type LucideIcon,
  Music,
  Plug,
  Power,
  Radar,
  Radio,
  SlidersHorizontal,
  Speaker,
  Sun,
  Tag,
  Thermometer,
  ToggleRight,
  Tv,
  Warehouse,
  Wifi,
  Zap,
} from "lucide-react";
import type { Entity } from "./grouping";

function deviceClass(e: Entity): string {
  const dc = e.attributes.device_class;
  return typeof dc === "string" ? dc : "";
}

export function iconFor(e: Entity): LucideIcon {
  const dc = deviceClass(e);
  switch (e.domain) {
    case "light":
      return Lightbulb;
    case "switch":
      return dc === "outlet" ? Plug : Power;
    case "input_boolean":
      return ToggleRight;
    case "fan":
      return Fan;
    case "climate":
      return Thermometer;
    case "media_player":
      return dc === "tv"
        ? Tv
        : dc === "speaker"
          ? Speaker
          : dc === "receiver"
            ? Radio
            : Music;
    case "cover":
      return dc === "garage" ? Warehouse : dc === "door" ? DoorClosed : Blinds;
    case "lock":
      return e.state === "locked" ? Lock : LockOpen;
    case "remote":
      return Tv;
    case "button":
      return CircleDot;
    case "camera":
      return Cctv;
    case "event":
      return dc === "doorbell" ? BellRing : dc === "motion" ? Activity : Bell;
    case "input_number":
    case "number":
      return SlidersHorizontal;
    case "select":
    case "input_select":
      return List;
    case "sensor":
      return sensorIcon(dc);
    case "binary_sensor":
      return binaryIcon(dc, e.state === "on");
    default:
      return Circle;
  }
}

function sensorIcon(dc: string): LucideIcon {
  switch (dc) {
    case "temperature":
      return Thermometer;
    case "humidity":
      return Droplets;
    case "power":
    case "energy":
    case "current":
    case "voltage":
    case "apparent_power":
    case "reactive_power":
      return Zap;
    case "battery":
      return Battery;
    case "pressure":
    case "atmospheric_pressure":
      return Gauge;
    case "illuminance":
      return Sun;
    case "timestamp":
    case "duration":
      return Clock;
    case "signal_strength":
      return Wifi;
    case "enum":
      return Tag;
    default:
      return Gauge;
  }
}

function binaryIcon(dc: string, on: boolean): LucideIcon {
  switch (dc) {
    case "motion":
    case "occupancy":
    case "presence":
    case "moving":
      return Radar;
    case "door":
    case "garage_door":
    case "window":
    case "opening":
      return on ? DoorOpen : DoorClosed;
    case "battery":
      return on ? BatteryLow : Battery;
    case "moisture":
      return Droplet;
    case "smoke":
    case "gas":
    case "carbon_monoxide":
      return Flame;
    case "connectivity":
      return Wifi;
    default:
      return CircleDot;
  }
}
