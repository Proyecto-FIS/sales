const express = require("express");
const AuthorizeJWT = require("../middlewares/AuthorizeJWT");
const Subscription = require("../models/Subscription");
const Validators = require("../middlewares/Validators");
const { stripePaymentMethodsAttach, stripeCustomersUpdate, stripeSubscriptionsCreate, stripeWebhooksConstructEvent, stripeSubscriptionsDel, productsRetrieveProducts, deliveriesCreate, usersGetCustomer } = require("../StripeCircuitBreaker");

const stripe = require('stripe');
// (process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOKS_PAY_INTENT_SUCCESS;

/**
 * @typedef Product
 * @property {string} _id               - Product identifier
 * @property {number} quantity          - Number of products of this type
 * @property {number} unitPriceEuros    - Price per unit, in euros
 * @property {string} stripe_price      - Price stripe identifier
 * @property {string} stripe_product    - Product stripe identifier
 */

/**
 * @typedef Subscription
 * @property {string} _id               - Unique identifier for this subscription
 * @property {string} userID            - User JWT token
 * @property {string} timestamp         - Date & time when the operation ocurred
 * @property {string} transaction_subscription_id     - Transaction identifier
 * @property {Array.<Product>} products - Products which have been bought
 * @property {integer} price            - Total amount of products purchased
 * @property {boolean} is_active        - Boolean that indicates if the subscription is active
 * @property {string} billing_profile_id - Unique identifier for billing profile 
 * @property {string} payment_method_id - Unique stripe identifier for payment method 
 */

/**
 * @typedef SubscriptionPost
 * @property {Subscription.model} subscription - Subscription to add
 */

class SubscriptionController {

  createSubscription(sub) {
    const subscription = new Subscription(sub);
    return subscription.save();
  }

  createSubscriptions(subs) {
    const promises = subs.map(entry => this.createSubscription(entry));
    return Promise.all(promises);
  }

  /**
   * Create a new subscription
   * @route POST /subscription
   * @group subscription - Monthly subscription
   * @param {string}  userToken.query.required          - User JWT token
   * @param {SubscriptionPost.model} subscription.body.required   - New subscription
   * @returns {string}                                  200 - Returns the subscription identifier
   * @returns {ValidationError}                         400 - Supplied parameters are invalid
   * @returns {UserAuthError}                           401 - User is not authorized to perform this operation
   * @returns {DatabaseError}                           500 - Database error
   */
  async subscriptionMethod(req, res) {
    const {
      billingProfile
    } = req.body;
    const {
      products
    } = req.body.subscription;
    const {
      payment_method_id
    } = req.body.subscription;

    const customer_id = req.query.userID.toHexString();
    const customer = await usersGetCustomer.execute(customer_id, {
        params: {
          id: customer_id
        }
      })
      .catch(error => {
        console.error(error)
      });

    let productsHistoryAndDeliveries = [];
    let identifiers = products.reduce((acc, current) => acc.concat(current._id + ","), "");
    identifiers = identifiers.substring(0, identifiers.length - 1);
    // TODO: cambiar ENDPOINT cuando el microservicio de products actualice el api gateway
    const productsToBuy = await productsRetrieveProducts.execute({
      params: {
        identifiers
      }
    }).then(result => {
      var productsToBuy = result.data.map(function (prod, index) {
        const aux = products.filter(p => p._id == prod._id);
        const product = {};
        const product2 = {};
        product2['_id'] = aux[0]._id;
        product2['quantity'] = aux[0].quantity;
        product['quantity'] = aux[0].quantity;
        product['stripe_id_product'] = prod.stripe_id;
        const formatAux = prod.format.filter(element => element.name == aux[0].format);
        product['unitPriceEuros'] = formatAux[0].price;
        product2['unitPriceEuros'] = formatAux[0].price;
        product['stripe_id_price'] = formatAux[0].stripe_id;
        productsHistoryAndDeliveries.push(product2);
        return product;
      })
      return productsToBuy
    }).catch(error => {
      console.error(error)
    });

    // Obtengo el precio total a partir de la lista de productos extraida de la base de datos para evitar que se edite el precio en frontend
    const totalPrice = productsToBuy.reduce((totalPrice, product) => totalPrice + (product.quantity * product.unitPriceEuros), 0);

    const paymentMethodAttached = await stripePaymentMethodsAttach.execute(this.stripeClient,
      payment_method_id, {
        customer: customer.data.stripe_id
      }
    ).catch(err => {
      console.log('¡Ha habido un error! ' + err);
    });

    const customerStripe = await stripeCustomersUpdate.execute(this.stripeClient,
      customer.data.stripe_id, {
        invoice_settings: {
          default_payment_method: payment_method_id,
        }
      }).catch(err => {
      console.log('¡Ha habido un error! ' + err);
    });

    let prices = productsToBuy.reduce((acc, current) => {
      acc.push({
        quantity: current.quantity,
        price: current.stripe_id_price
      });
      return acc;
    }, []);

    const subscription = await stripeSubscriptionsCreate.execute(this.stripeClient, {
      customer: customer.data.stripe_id,
      items: prices,
      expand: ['latest_invoice.payment_intent']
    }).catch(err => {
      console.log('¡Ha habido un error! ' + err);
    });
    const status = subscription['latest_invoice']['payment_intent']['status']
    const client_secret = subscription['latest_invoice']['payment_intent']['client_secret']


    req.body.subscription.price = totalPrice;
    req.body.subscription.transaction_subscription_id = subscription.id;
    req.body.subscription.billing_profile_id = billingProfile._id;
    req.body.subscription.products = productsToBuy;
    req.body.subscription.payment_method_id = payment_method_id

    delete req.body.subscription._id; // Ignore _id to prevent key duplication
    req.body.subscription.userID = req.query.userID;
    const userToken = req.query.userToken;

    new Subscription(req.body.subscription)
      .save()
      .then(doc => {
        // History entry
        const entry = {
          userID: doc.userID,
          operationType: "subscription",
          products: productsHistoryAndDeliveries,
          transaction_id: doc._id
        };
        return this.historyController.createEntry(entry);
      }).then(doc => {
        // Delivery
        return deliveriesCreate.execute({
          "historyId": doc._id,
          "profile": billingProfile,
          "products": productsHistoryAndDeliveries
        }, {
          params: {
            userToken
          }
        })
      }).then(doc => {
        res.status(200).json({
          'client_secret': client_secret,
          'status': status
        })
      }).catch(err => {
        res.status(500).json({
          reason: "Database error"
        })
      });
  }


  async webhooksMethod(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripeWebhooksConstructEvent.execute(this.stripeClient, req.rawBody, sig, endpointSecret);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const email = event['data']['object']['receipt_email'] // contains the email that will recive the recipt for the payment (users email usually)
        console.log(`PaymentIntent was successful for ${email}!`)
        break;
      }
      default:
        // Unexpected event type
        return res.status(400).end();
    }

    // Return a 200 response to acknowledge receipt of the event
    res.json({
      received: true
    });
  };

  async deleteStripeSubscription(transaction_subscription_id) {
    return transaction_subscription_id === "sub_test_Ii6Wx96kiwqKpW"? false : await stripeSubscriptionsDel.execute(this.stripeClient,
      transaction_subscription_id
    ).catch(() => {
      // console.log("Error Subscription Stripe Delete: " + err);
      console.log("This subscription does not exist or has already been deleted");
    });
  }
  async deleteAllStripeSubscription(subscriptions) {
    let n = 0;
    subscriptions.forEach((element) => {
      stripeSubscriptionsDel.execute(this.stripeClient,
        element.transaction_subscription_id
      ).catch(err => {
        console.log("Error Subscription Stripe Delete: " + err);
      });
      n++;
    });
    return n;
  }

  /**
   * Deactivates an existing subscription
   * @route DELETE /subscription
   * @group subscription - Monthly subcription
   * @param {integer} subscriptionID - Subscription identifier
   * @param {string}  userToken.query.required         - User JWT token
   * @returns {Subscription}                      200 - Returns stripe subscription deactivated
   * @returns {ValidationError}       400 - Supplied parameters are invalid
   * @returns {UserAuthError}         401 - User is not authorized to perform this operation
   * @returns {DatabaseError}         500 - Database error
   */
  deleteMethod(req, res) {
    Subscription.findOneAndUpdate({
        _id: req.query.subscriptionID,
        userID: req.query.userID
      }, {
        is_active: false
      })
      .then(doc => {
        if (doc) {
          return Subscription.findById(doc._id);
        } else {
          res.sendStatus(401);
        }
      })
      .then(doc => {
        return this.deleteStripeSubscription(doc.transaction_subscription_id);
      })
      .then(doc => {
        res.status(200).json(doc ? doc : { "reason": "Subscription already deactivated"})
      })
      .catch(err => {
        res.status(500).json({
          reason: "Database error"
        })
      });

  }
  /**
   * Deactivates all users subscription
   * @route DELETE /all-subscription
   * @group subscription - Monthly subcription
   * @param {string}  userToken.query.required         - User JWT token
   * @returns {}                      204 - Returns nothing
   * @returns {ValidationError}       400 - Supplied parameters are invalid
   * @returns {UserAuthError}         401 - User is not authorized to perform this operation
   * @returns {DatabaseError}         500 - Database error
   */
  deleteAllMethod(req, res) {
    const subs = Subscription.find({
        userID: req.query.userID,
        is_active: true
      }).then((subscriptions) => {
        if (subscriptions && subscriptions.length > 0) {
          return this.deleteAllStripeSubscription(subscriptions);
        }
      }).then(() => {
        return Subscription.updateMany({
          userID: req.query.userID
        }, {
          is_active: false
        });
      })
      .then(doc => {
        res.status(200).json(doc.nModified > 0 ? doc : {
          "reason": "User has no subscription active"
        })
      }).catch(err => res.status(500).json({
        reason: "Database error" + err
      }));
  }

  /**
   * Get all user subscriptions
   * @route GET /subscriptions
   * @group subscription - Monthly subscription
   * @param {string}  userToken.query.required         - User JWT token
   * @returns {Array.<Subscription>}  200 - Returns the requested subscriptions
   * @returns {ValidationError}       400 - Supplied parameters are invalid
   * @returns {UserAuthError}         401 - User is not authorized to perform this operation
   * @returns {DatabaseError}         500 - Database error
   */
  getSubscriptions(req, res) {
    Subscription.find({
        userID: req.query.userID,
        timestamp: {
          $lt: req.query.beforeTimestamp
        }
      })
      .select("timestamp price products is_active")
      .sort("-timestamp")
      .lean()
      .exec((err, entries) => {
        if (err) {
          res.status(500).json({
            reason: "Database error"
          });
        } else {
          res.status(200).json(entries);
        }
      });
  };

  /**
   * Get a subscription
   * @route GET /subscription
   * @group subscription - Monthly subscription
   * @param {string}  userToken.query.required                - User JWT token
   * @param {string} transaction_payment_id.query.required    - Identificador de la transacción
   * @returns {Array.<HistoryEntry>}  200 - Returns the requested entries
   * @returns {ValidationError}       400 - Supplied parameters are invalid
   * @returns {UserAuthError}         401 - User is not authorized to perform this operation
   * @returns {DatabaseError}         500 - Database error
   */
  getMethod(req, res) {
    Subscription.find({
        userID: req.query.userID,
        transaction_subscription_id: req.query.transaction_subscription_id
      })
      .lean()
      .exec((err, entries) => {
        if (err) {
          res.status(500).json({
            reason: "Database error"
          });
        } else {
          res.status(200).json(entries);
        }
      });
  };

  constructor(apiPrefix, router, historyController) {
    const route = apiPrefix + "/subscription";
    const userTokenValidators = [Validators.Required("userToken"), AuthorizeJWT];
    const beforeTimestampValidators = [Validators.Required("beforeTimestamp"), Validators.ToDate("beforeTimestamp")];
    const pageSizeValidators = [Validators.Required("pageSize"), Validators.Range("pageSize", 1, 20)];
    router.get(apiPrefix + "/subscriptions", ...userTokenValidators, ...beforeTimestampValidators, this.getSubscriptions.bind(this));
    router.get(apiPrefix + "/subscription", ...userTokenValidators, this.getMethod.bind(this));
    router.post(apiPrefix + "/subscription", ...userTokenValidators, Validators.Required("subscription"), this.subscriptionMethod.bind(this));
    router.post(apiPrefix + "/stripewebhook", ...userTokenValidators, Validators.Required("subscription"), this.webhooksMethod.bind(this));
    router.delete(route, ...userTokenValidators, Validators.Required("subscriptionID"), this.deleteMethod.bind(this));
    router.delete(apiPrefix + "/all-subscription", ...userTokenValidators, this.deleteAllMethod.bind(this));
    this.historyController = historyController;
    this.stripeClient = stripe(process.env.STRIPE_SECRET_KEY);
  }
}

module.exports = SubscriptionController;