export type Auction = {
  id: string
  title: string
  description?: string
  startingPrice: number
  currentPrice: number
  endsAt: string // ISO
  createdAt: string // ISO
}

export type BidEvent = {
  type: 'bid:accepted'
  auctionId: string
  amount: number
  userId: string
  at: string // ISO
}
