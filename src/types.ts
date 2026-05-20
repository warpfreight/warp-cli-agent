export interface QuoteService {
  mode: string;
  vehicle: string;
  pickup_date: string;
  delivery_date: string;
  transit_days: number;
  pricing: string;
  included_at_no_charge: string[];
  dispatch: string;
}

export interface QuoteAssumptions {
  weight_lbs_per_pallet: number;
  freight_class?: string;
  commodity?: string;
  dims_in: { length: number; width: number; height: number };
  stackable: boolean;
  hazmat: boolean;
}

export interface QuoteResponse {
  quote_id: string;
  lane_id: string;
  mode: string;
  price_usd: number;
  currency: string;
  transit_days: number;
  pickup_date: string;
  delivery_date: string;
  expires_at: string;
  quote_tier: "firm" | "indicative";
  service: QuoteService;
  assumptions: QuoteAssumptions;
  missing_for_ship: string[];
  booking_url: string;
  book_tool_call: { tool: string; args: { quote_id: string } };
}

export interface AddressContact {
  zipCode: string;
  city: string;
  state: string;
  street: string;
  contactName: string;
  company?: string;
  phone: string;
  email: string;
  specialInstruction?: string;
  /** Time window e.g. '08:00-17:00' — defaults to 08:00-17:00 if not provided */
  window?: string;
}

export interface BookPatch {
  pickup?: AddressContact;
  delivery?: AddressContact;
  notes?: string;
  listItems?: unknown[];
}

export interface BookResponse {
  booked: boolean;
  shipment_id: string;
  shipment_number: string;
  tracking_number: string;
  lane_id: string;
  service: QuoteService;
  tracking_dashboard?: string;
}

export interface VersionResponse {
  api: string;
  commit: string;
  built_at: string;
}

export interface Lane {
  lane_id: string;
  ship_count: number;
  last_shipped_at: string;
  last_consignee: Record<string, unknown>;
  last_pallet_count: number;
}

export interface LanesResponse {
  lanes: Lane[];
}

export interface ApiError {
  error: string;
  code?: string;
  missing_fields?: string[];
}
