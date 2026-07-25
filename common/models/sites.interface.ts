export interface ISites {
  buffington: Site
}

export interface Site {
  name: string
  description: string
  mqtt: string
  webhook: string
  address: Address
  rooms: Rooms
}

export interface Address {
  street: string
  city: string
  state: string
  zip: string
}

export interface Rooms {
  [key: string]: Room
}

export interface Room {
  name: string
  description?: string
  switches?: Switch[]
}

export interface Switch {
  name: string
  description: string
  type: string
  state: boolean
  channel: number
}

