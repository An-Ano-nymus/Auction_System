import { Sequelize, DataTypes } from 'sequelize';
import { URL } from 'url';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set. Sequelize will not connect. Some features will be disabled until configured.');
}
export const sequelize = DATABASE_URL
    ? (() => {
        const u = new URL(DATABASE_URL);
        const username = decodeURIComponent(u.username);
        const password = decodeURIComponent(u.password);
        const database = u.pathname.replace(/^\//, '');
        const host = process.env.PGHOSTADDR || u.hostname;
        const port = Number(u.port || 5432);
        return new Sequelize(database, username, password, {
            host,
            port,
            dialect: 'postgres',
            logging: false,
            dialectOptions: {
                ssl: { require: true, rejectUnauthorized: false }
            }
        });
    })()
    : null;
export let AuctionModel;
export let BidModel;
export let CounterOfferModel;
export let NotificationModel;
export async function initModels() {
    if (!sequelize)
        return;
    AuctionModel = sequelize.define('Auction', {
        id: { type: DataTypes.STRING, primaryKey: true },
        sellerId: { type: DataTypes.STRING, allowNull: false },
        title: { type: DataTypes.STRING(200), allowNull: false },
        description: { type: DataTypes.TEXT, allowNull: true },
        startingPrice: { type: DataTypes.DECIMAL, allowNull: false },
        bidIncrement: { type: DataTypes.DECIMAL, allowNull: false },
        goLiveAt: { type: DataTypes.DATE, allowNull: false },
        endsAt: { type: DataTypes.DATE, allowNull: false },
        currentPrice: { type: DataTypes.DECIMAL, allowNull: false, defaultValue: 0 },
        status: { type: DataTypes.ENUM('scheduled', 'live', 'ended', 'closed'), allowNull: false, defaultValue: 'scheduled' },
    }, { tableName: 'auctions', timestamps: true });
    BidModel = sequelize.define('Bid', {
        id: { type: DataTypes.STRING, primaryKey: true },
        auctionId: { type: DataTypes.STRING, allowNull: false },
        bidderId: { type: DataTypes.STRING, allowNull: false },
        amount: { type: DataTypes.DECIMAL, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }
    }, { tableName: 'bids', timestamps: false });
    CounterOfferModel = sequelize.define('CounterOffer', {
        id: { type: DataTypes.STRING, primaryKey: true },
        auctionId: { type: DataTypes.STRING, allowNull: false },
        sellerId: { type: DataTypes.STRING, allowNull: false },
        buyerId: { type: DataTypes.STRING, allowNull: false },
        amount: { type: DataTypes.DECIMAL, allowNull: false },
        status: { type: DataTypes.ENUM('pending', 'accepted', 'rejected'), allowNull: false, defaultValue: 'pending' },
    }, { tableName: 'counter_offers', timestamps: true });
    NotificationModel = sequelize.define('Notification', {
        id: { type: DataTypes.STRING, primaryKey: true },
        userId: { type: DataTypes.STRING, allowNull: false },
        type: { type: DataTypes.STRING, allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false },
        read: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    }, { tableName: 'notifications', timestamps: false });
    await sequelize.sync();
}
