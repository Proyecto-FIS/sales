const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const ProductSchema = new Schema({
    _id: Schema.ObjectId,
    quantity: {
        type: Number,
        min: 1,
        required: true,
        validate: {
            validator: Number.isInteger
        }
    },
    unitPriceEuros: {
        type: Number,
        min: 0,
        required: true
    }
});

const PaymentSchema = new Schema({
    userID: Schema.ObjectId,
    timestamp: {
        type: Date,
        default: Date.now
    },
    products: {
        type: [ProductSchema],
        required: true
    },
    transaction_payment_id: { // stripe paymentIntent id
        type: String,
        required: [true, "Transaction payment id required"],
        minlength: 1,
        maxlength: 100
    },
    price: {
        type: Number,
        required: [true, "Price required"]
    },
    billing_profile_id: {
        type: Schema.Types.ObjectId,
        required: [true, "Billing profile id required"]
    }
});

module.exports = mongoose.model("Payment", PaymentSchema);
