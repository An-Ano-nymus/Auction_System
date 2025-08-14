export type Auction = {
    id: string;
    title: string;
    description?: string;
    startingPrice: number;
    currentPrice: number;
    endsAt: string;
    createdAt: string;
};
export type BidEvent = {
    type: 'bid:accepted';
    auctionId: string;
    amount: number;
    userId: string;
    at: string;
};
