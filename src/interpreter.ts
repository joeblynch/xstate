import {
  StateMachine,
  Event,
  EventObject,
  CancelAction,
  DefaultContext,
  ActionObject,
  StateSchema,
  ActivityActionObject,
  SpecialTargets,
  ActionTypes,
  InvokeDefinition,
  OmniEventObject,
  OmniEvent,
  SendActionObject,
  ServiceConfig,
  InvokeCallback,
  Sender,
  DisposeActivityFunction,
  ErrorExecutionEvent,
  StateValue,
  DevToolsConnect,
  InterpreterOptions,
  ActivityDefinition,
  SingleOrArray
} from './types';
import { State } from './State';
import * as actionTypes from './actionTypes';
import { toEventObject, doneInvoke, error } from './actions';
import { IS_PRODUCTION } from './StateNode';
import {
  isPromiseLike,
  mapContext,
  bindActionToState,
  warn,
  keys,
  isArray,
  isFunction,
  isString
} from './utils';
import { Scheduler } from './scheduler';

export type StateListener<TContext, TEvent extends EventObject> = (
  state: State<TContext, TEvent>,
  event: OmniEventObject<TEvent>
) => void;

export type ContextListener<TContext = DefaultContext> = (
  context: TContext,
  prevContext: TContext | undefined
) => void;

export type EventListener = (event: EventObject) => void;

export type Listener = () => void;

export interface Clock {
  setTimeout(fn: (...args: any[]) => void, timeout: number): any;
  clearTimeout(id: any): void;
}

export interface SimulatedClock extends Clock {
  start(speed: number): void;
  increment(ms: number): void;
  set(ms: number): void;
}

interface SimulatedTimeout {
  start: number;
  timeout: number;
  fn: (...args: any[]) => void;
}
export class SimulatedClock implements SimulatedClock {
  private timeouts: Map<number, SimulatedTimeout> = new Map();
  private _now: number = 0;
  private _id: number = 0;
  public now() {
    return this._now;
  }
  private getId() {
    return this._id++;
  }
  public setTimeout(fn: (...args: any[]) => void, timeout: number) {
    const id = this.getId();
    this.timeouts.set(id, {
      start: this.now(),
      timeout,
      fn
    });
    return id;
  }
  public clearTimeout(id: number) {
    this.timeouts.delete(id);
  }
  public set(time: number) {
    if (this._now > time) {
      throw new Error('Unable to travel back in time');
    }

    this._now = time;
    this.flushTimeouts();
  }
  private flushTimeouts() {
    this.timeouts.forEach((timeout, id) => {
      if (this.now() - timeout.start >= timeout.timeout) {
        timeout.fn.call(null);
        this.timeouts.delete(id);
      }
    });
  }
  public increment(ms: number): void {
    this._now += ms;
    this.flushTimeouts();
  }
}

export interface Actor {
  send: Sender<any>;
  stop: (() => void) | void;
}

export class Interpreter<
  // tslint:disable-next-line:max-classes-per-file
  TContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject
> {
  /**
   * The default interpreter options:
   *
   * - `clock` uses the global `setTimeout` and `clearTimeout` functions
   * - `logger` uses the global `console.log()` method
   */
  public static defaultOptions: InterpreterOptions = (global => ({
    execute: true,
    deferEvents: true,
    clock: {
      setTimeout: (fn, ms) => {
        return global.setTimeout.call(null, fn, ms);
      },
      clearTimeout: id => {
        return global.clearTimeout.call(null, id);
      }
    },
    logger: global.console.log.bind(console),
    devTools: false
  }))(typeof window === 'undefined' ? global : window);
  /**
   * The current state of the interpreted machine.
   */
  public state: State<TContext, TEvent>;
  /**
   * The clock that is responsible for setting and clearing timeouts, such as delayed events and transitions.
   */
  public clock: Clock;
  public options: Readonly<InterpreterOptions>;

  private scheduler: Scheduler = new Scheduler();
  private delayedEventsMap: Record<string, number> = {};
  private listeners: Set<StateListener<TContext, TEvent>> = new Set();
  private contextListeners: Set<ContextListener<TContext>> = new Set();
  private stopListeners: Set<Listener> = new Set();
  private doneListeners: Set<EventListener> = new Set();
  private eventListeners: Set<EventListener> = new Set();
  private sendListeners: Set<EventListener> = new Set();
  private logger: (...args: any[]) => void;
  private initialized = false;

  // Actor
  public parent?: Interpreter<any>;
  public id: string;
  private children: Map<string | number, Actor> = new Map();
  private forwardTo: Set<string> = new Set();

  // Dev Tools
  private devTools?: any;

  /**
   * Creates a new Interpreter instance (i.e., service) for the given machine with the provided options, if any.
   *
   * @param machine The machine to be interpreted
   * @param options Interpreter options
   */
  constructor(
    public machine: StateMachine<TContext, TStateSchema, TEvent>,
    options: Partial<InterpreterOptions> = Interpreter.defaultOptions
  ) {
    const resolvedOptions: InterpreterOptions = {
      ...Interpreter.defaultOptions,
      ...options
    };

    const { clock, logger, parent, id } = resolvedOptions;

    const resolvedId = id !== undefined ? id : machine.id;

    Object.assign(this, {
      clock,
      logger,
      parent,
      id: resolvedId
    });

    this.options = resolvedOptions;

    this.scheduler = new Scheduler({
      deferEvents: this.options.deferEvents
    });
  }
  public static interpret = interpret;
  /**
   * The initial state of the statechart.
   */
  public get initialState(): State<TContext, TEvent> {
    return this.machine.initialState;
  }
  /**
   * Executes the actions of the given state, with that state's `context` and `event`.
   *
   * @param state The state whose actions will be executed
   */
  public execute(state: State<TContext, TEvent>): void {
    for (const action of state.actions) {
      this.exec(action, state.context, state.event);
    }
  }
  private update(
    state: State<TContext, TEvent>,
    event: OmniEventObject<TEvent>
  ): void {
    // Update state
    this.state = state;

    // Execute actions
    if (this.options.execute) {
      this.execute(this.state);
    }

    // Dev tools
    if (this.devTools) {
      this.devTools.send(event, state);
    }

    // Execute listeners
    if (state.event) {
      for (const listener of this.eventListeners) {
        listener(state.event);
      }
    }

    for (const listener of this.listeners) {
      listener(state, state.event);
    }

    for (const contextListener of this.contextListeners) {
      contextListener(
        this.state.context,
        this.state.history ? this.state.history.context : undefined
      );
    }

    if (this.state.tree && this.state.tree.done) {
      // get donedata
      const doneData = this.state.tree.getDoneData(
        this.state.context,
        toEventObject<OmniEventObject<TEvent>>(event)
      );
      for (const listener of this.doneListeners) {
        listener(doneInvoke(this.id, doneData));
      }
      this.stop();
    }
  }
  /*
   * Adds a listener that is notified whenever a state transition happens. The listener is called with
   * the next state and the event object that caused the state transition.
   *
   * @param listener The state listener
   */
  public onTransition(
    listener: StateListener<TContext, TEvent>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.listeners.add(listener);
    return this;
  }
  /**
   * Adds an event listener that is notified whenever an event is sent to the running interpreter.
   * @param listener The event listener
   */
  public onEvent(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.eventListeners.add(listener);
    return this;
  }
  /**
   * Adds an event listener that is notified whenever a `send` event occurs.
   * @param listener The event listener
   */
  public onSend(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.sendListeners.add(listener);
    return this;
  }
  /**
   * Adds a context listener that is notified whenever the state context changes.
   * @param listener The context listener
   */
  public onChange(
    listener: ContextListener<TContext>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.contextListeners.add(listener);
    return this;
  }
  /**
   * Adds a listener that is notified when the machine is stopped.
   * @param listener The listener
   */
  public onStop(
    listener: Listener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.stopListeners.add(listener);
    return this;
  }
  /**
   * Adds a state listener that is notified when the statechart has reached its final state.
   * @param listener The state listener
   */
  public onDone(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.doneListeners.add(listener);
    return this;
  }
  /**
   * Removes a listener.
   * @param listener The listener to remove
   */
  public off(
    listener: (...args: any[]) => void
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.listeners.delete(listener);
    this.eventListeners.delete(listener);
    this.sendListeners.delete(listener);
    this.stopListeners.delete(listener);
    this.doneListeners.delete(listener);
    this.contextListeners.delete(listener);
    return this;
  }
  /**
   * Alias for Interpreter.prototype.start
   */
  public init = this.start;
  /**
   * Starts the interpreter from the given state, or the initial state.
   * @param initialState The state to start the statechart from
   */
  public start(
    initialState?: State<TContext, TEvent> | StateValue
  ): Interpreter<TContext, TStateSchema, TEvent> {
    const resolvedState =
      initialState === undefined
        ? this.machine.initialState
        : initialState instanceof State
        ? this.machine.resolveState(initialState)
        : this.machine.resolveState(State.from(initialState));
    this.initialized = true;
    if (this.options.devTools) {
      this.attachDev();
    }
    this.scheduler.initialize(() => {
      this.update(resolvedState, { type: actionTypes.init });
    });
    return this;
  }
  /**
   * Stops the interpreter and unsubscribe all listeners.
   *
   * This will also notify the `onStop` listeners.
   */
  public stop(): Interpreter<TContext, TStateSchema, TEvent> {
    for (const listener of this.listeners) {
      this.listeners.delete(listener);
    }
    for (const listener of this.stopListeners) {
      // call listener, then remove
      listener();
      this.stopListeners.delete(listener);
    }
    for (const listener of this.contextListeners) {
      this.contextListeners.delete(listener);
    }
    for (const listener of this.doneListeners) {
      this.doneListeners.delete(listener);
    }

    // Stop all children
    this.children.forEach(child => {
      if (isFunction(child.stop)) {
        child.stop();
      }
    });

    // Cancel all delayed events
    for (const key of keys(this.delayedEventsMap)) {
      this.clock.clearTimeout(this.delayedEventsMap[key]);
    }

    this.initialized = false;

    return this;
  }
  /**
   * Sends an event to the running interpreter to trigger a transition.
   *
   * An array of events (batched) can be sent as well, which will send all
   * batched events to the running interpreter. The listeners will be
   * notified only **once** when all events are processed.
   *
   * @param event The event(s) to send
   */
  public send = (
    event: SingleOrArray<OmniEvent<TEvent>>,
    payload?: Record<string, any> & { type?: never }
  ): State<TContext, TEvent> => {
    if (isArray(event)) {
      this.batch(event);
      return this.state;
    }

    const eventObject = toEventObject<OmniEventObject<TEvent>>(event, payload);
    if (!this.initialized && this.options.deferEvents) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event "${eventObject.type}" was sent to uninitialized service "${
            this.machine.id
          }" and is deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            event
          )}`
        );
      }
    } else if (!this.initialized) {
      throw new Error(
        `Event "${eventObject.type}" was sent to uninitialized service "${
          this.machine.id
          // tslint:disable-next-line:max-line-length
        }". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.\nEvent: ${JSON.stringify(
          eventObject
        )}`
      );
    }

    this.scheduler.schedule(() => {
      const nextState = this.nextState(eventObject);

      this.update(nextState, eventObject);

      // Forward copy of event to child interpreters
      this.forward(eventObject);
    });

    return this.state; // TODO: deprecate (should return void)
    // tslint:disable-next-line:semicolon
  };

  private batch(events: Array<OmniEvent<TEvent>>): void {
    if (!this.initialized && this.options.deferEvents) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `${events.length} event(s) were sent to uninitialized service "${
            this.machine.id
          }" and are deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            event
          )}`
        );
      }
    } else if (!this.initialized) {
      throw new Error(
        `${events.length} event(s) were sent to uninitialized service "${
          this.machine.id
        }". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.`
      );
    }

    this.scheduler.schedule(() => {
      let nextState = this.state;
      for (const event of events) {
        const eventObject = toEventObject<OmniEventObject<TEvent>>(event);
        const actions = nextState.actions.map(a =>
          bindActionToState(a, nextState)
        );
        nextState = this.machine.transition(nextState, eventObject);
        nextState.actions.unshift(...actions);

        this.forward(eventObject);
      }

      this.update(
        nextState,
        toEventObject<OmniEventObject<TEvent>>(events[events.length - 1])
      );
    });
  }

  /**
   * Returns a send function bound to this interpreter instance.
   *
   * @param event The event to be sent by the sender.
   */
  public sender = (event: Event<TEvent>): (() => State<TContext, TEvent>) => {
    function sender() {
      return this.send(event);
    }

    return sender.bind(this);
  }

  public sendTo = (event: OmniEventObject<TEvent>, to: string | number) => {
    const isParent = to === SpecialTargets.Parent;
    const target = isParent ? this.parent : this.children.get(to);

    if (!target) {
      if (!isParent) {
        throw new Error(
          `Unable to send event to child '${to}' from service '${this.id}'.`
        );
      }

      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Service '${this.id}' has no parent: unable to send event ${
            event.type
          }`
        );
      }
      return;
    }

    target.send(event);
  }
  /**
   * Returns the next state given the interpreter's current state and the event.
   *
   * This is a pure method that does _not_ update the interpreter's state.
   *
   * @param event The event to determine the next state
   */
  public nextState(event: OmniEvent<TEvent>): State<TContext, TEvent> {
    const eventObject = toEventObject<OmniEventObject<TEvent>>(event);

    if (
      eventObject.type === actionTypes.errorExecution &&
      this.state.nextEvents.indexOf(actionTypes.errorExecution) === -1
    ) {
      throw (eventObject as ErrorExecutionEvent).data;
    }

    spawnContext.serviceStack.push(this);
    const nextState = this.machine.transition(
      this.state,
      eventObject,
      this.state.context
    );
    spawnContext.serviceStack.pop();

    return nextState;
  }
  private forward(event: OmniEventObject<TEvent>): void {
    for (const id of this.forwardTo) {
      const child = this.children.get(id);

      if (!child) {
        throw new Error(
          `Unable to forward event '${event}' from interpreter '${
            this.id
          }' to nonexistant child '${id}'.`
        );
      }

      child.send(event);
    }
  }
  private defer(sendAction: SendActionObject<TContext, TEvent>): void {
    let { delay } = sendAction;

    if (isString(delay)) {
      if (
        !this.machine.options.delays ||
        this.machine.options.delays[delay] === undefined
      ) {
        // tslint:disable-next-line:no-console
        if (!IS_PRODUCTION) {
          warn(
            false,
            `No delay reference for delay expression '${delay}' was found on machine '${
              this.machine.id
            }' on service '${this.id}'.`
          );
        }

        // Do not send anything
        return;
      } else {
        const delayExpr = this.machine.options.delays[delay];
        delay =
          typeof delayExpr === 'number'
            ? delayExpr
            : delayExpr(this.state.context, this.state.event);
      }
    }

    this.delayedEventsMap[sendAction.id] = this.clock.setTimeout(() => {
      if (sendAction.to) {
        this.sendTo(sendAction.event, sendAction.to);
      } else {
        this.send(sendAction.event);
      }
    }, (delay as number) || 0);
  }
  private cancel(sendId: string | number): void {
    this.clock.clearTimeout(this.delayedEventsMap[sendId]);
    delete this.delayedEventsMap[sendId];
  }
  private exec(
    action: ActionObject<TContext, OmniEventObject<TEvent>>,
    context: TContext,
    event: OmniEventObject<TEvent>
  ): void {
    if (action.exec) {
      return action.exec(context, event, { action, state: this.state });
    }

    switch (action.type) {
      case actionTypes.send:
        const sendAction = action as SendActionObject<TContext, TEvent>;

        if (sendAction.delay) {
          this.defer(sendAction);
          return;
        } else {
          if (sendAction.to) {
            this.sendTo(sendAction.event, sendAction.to);
          } else {
            this.send(sendAction.event);
          }
        }
        break;

      case actionTypes.cancel:
        this.cancel((action as CancelAction).sendId);

        break;
      case actionTypes.start: {
        const activity = (action as ActivityActionObject<TContext, TEvent>)
          .activity as InvokeDefinition<TContext, TEvent>;

        // If the activity will be stopped right after it's started
        // (such as in transient states)
        // don't bother starting the activity.
        if (!this.state.activities[activity.type]) {
          break;
        }

        // Invoked services
        if (activity.type === ActionTypes.Invoke) {
          const serviceCreator: ServiceConfig<TContext> | undefined = this
            .machine.options.services
            ? this.machine.options.services[activity.src]
            : undefined;

          const { id, data } = activity;

          const autoForward = !!activity.forward;

          if (!serviceCreator) {
            // tslint:disable-next-line:no-console
            if (!IS_PRODUCTION) {
              warn(
                false,
                `No service found for invocation '${
                  activity.src
                }' in machine '${this.machine.id}'.`
              );
            }
            return;
          }

          const source = isFunction(serviceCreator)
            ? serviceCreator(context, event)
            : serviceCreator;

          if (isPromiseLike(source)) {
            this.spawnPromise(id, Promise.resolve(source));
          } else if (isFunction(source)) {
            this.spawnCallback(id, source);
          } else if (typeof source !== 'string') {
            // TODO: try/catch here
            this.spawn(
              data
                ? source.withContext(mapContext(data, context, event as TEvent))
                : source,
              {
                id,
                autoForward
              }
            );
          } else {
            // service is string
          }
        } else {
          this.spawnActivity(activity);
        }

        break;
      }
      case actionTypes.stop: {
        this.stopChild(action.activity.id);

        break;
      }

      case actionTypes.log:
        const expr = action.expr ? action.expr(context, event) : undefined;

        if (action.label) {
          this.logger(action.label, expr);
        } else {
          this.logger(expr);
        }
        break;
      default:
        if (!IS_PRODUCTION) {
          warn(
            false,
            `No implementation found for action type '${action.type}'`
          );
        }
        break;
    }

    return undefined;
  }
  private stopChild(childId: string): void {
    const child = this.children.get(childId);
    if (child && isFunction(child.stop)) {
      child.stop();
      this.children.delete(childId);
      this.forwardTo.delete(childId);
    }
  }
  public spawn<
    TChildContext,
    TChildStateSchema,
    TChildEvents extends EventObject
  >(
    machine: StateMachine<TChildContext, TChildStateSchema, TChildEvents>,
    options: { id?: string; autoForward?: boolean; subscribe?: boolean } = {}
  ): Interpreter<TChildContext, TChildStateSchema, TChildEvents> {
    const childService = new Interpreter(machine, {
      parent: this,
      id: options.id || machine.id
    });

    if (options.subscribe) {
      childService.onTransition(state => {
        this.send('xstate.update', { state }); // TODO: actionTypes
      });
    }

    childService
      .onDone(doneEvent => {
        this.send(doneEvent as OmniEvent<TEvent>); // todo: fix
      })
      .start();

    this.children.set(childService.id, childService);

    if (options.autoForward) {
      this.forwardTo.add(childService.id);
    }

    return childService;
  }
  private spawnPromise(id: string, promise: Promise<any>): void {
    let canceled = false;

    promise
      .then(response => {
        if (!canceled) {
          this.send(doneInvoke(id, response));
        }
      })
      .catch(errorData => {
        if (!canceled) {
          const errorEvent = error(errorData, id);
          try {
            // Send "error.execution" to this (parent).
            this.send(errorEvent);
          } catch (error) {
            if (!IS_PRODUCTION) {
              this.reportUnhandledExceptionOnInvocation(errorData, error, id);
            }
            if (this.devTools) {
              this.devTools.send(errorEvent, this.state);
            }
            if (this.machine.strict) {
              // it would be better to always stop the state machine if unhandled
              // exception/promise rejection happens but because we don't want to
              // break existing code so enforce it on strict mode only especially so
              // because documentation says that onError is optional
              this.stop();
            }
          }
        }
      });

    this.children.set(id, {
      send: () => void 0,
      stop: () => {
        canceled = true;
      }
    });
  }
  private spawnCallback(id: string, callback: InvokeCallback): void {
    const receive = (e: TEvent) => this.send(e);
    let listener = (e: EventObject) => {
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event '${
            e.type
          }' sent to callback service '${id}' but was not handled by a listener.`
        );
      }
    };

    let stop;

    try {
      stop = callback(receive, newListener => {
        listener = newListener;
      });

      if (isPromiseLike(stop)) {
        Promise.resolve(stop).catch(e => {
          const errorEvent = error(e, id);
          try {
            this.send(errorEvent);
          } catch (error) {
            if (!IS_PRODUCTION) {
              this.reportUnhandledExceptionOnInvocation(e, error, id);
            }
            if (this.devTools) {
              this.devTools.send(errorEvent, this.state);
            }
            if (this.machine.strict) {
              // it would be better to always stop the state machine if unhandled
              // exception/promise rejection happens but because we don't want to
              // break existing code so enforce it on strict mode only especially so
              // because documentation says that onError is optional
              this.stop();
            }
          }
        });
      }
    } catch (e) {
      this.send(error(e, id));
    }

    this.children.set(id, {
      send: listener,
      stop
    });
  }
  private spawnActivity(activity: ActivityDefinition<TContext, TEvent>): void {
    const implementation =
      this.machine.options && this.machine.options.activities
        ? this.machine.options.activities[activity.type]
        : undefined;

    if (!implementation) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(false, `No implementation found for activity '${activity.type}'`);
      }
      return;
    }

    // Start implementation
    const dispose = implementation(this.state.context, activity);
    this.spawnEffect(activity.id, dispose);
  }
  private spawnEffect(
    id: string,
    dispose?: DisposeActivityFunction | void
  ): void {
    this.children.set(id, {
      send: () => void 0,
      stop: dispose
    });
  }
  private reportUnhandledExceptionOnInvocation(
    originalError: any,
    currentError: any,
    id: string
  ) {
    const originalStackTrace = originalError.stack
      ? ` Stacktrace was '${originalError.stack}'`
      : '';
    if (originalError === currentError) {
      // tslint:disable-next-line:no-console
      console.error(
        `Missing onError handler for invocation '${id}', error was '${originalError}'.${originalStackTrace}`
      );
    } else {
      const stackTrace = currentError.stack
        ? ` Stacktrace was '${currentError.stack}'`
        : '';
      // tslint:disable-next-line:no-console
      console.error(
        `Missing onError handler and/or unhandled exception/promise rejection for invocation '${id}'. ` +
          `Original error: '${originalError}'. ${originalStackTrace} Current error is '${currentError}'.${stackTrace}`
      );
    }
  }
  private attachDev() {
    let connect: DevToolsConnect | null = null;

    if (this.options.devTools === true && typeof window !== 'undefined') {
      const { __REDUX_DEVTOOLS_EXTENSION__ } = (window as any);
      if (__REDUX_DEVTOOLS_EXTENSION__) {
        connect = __REDUX_DEVTOOLS_EXTENSION__.connect.bind(__REDUX_DEVTOOLS_EXTENSION__);
      }
    } else if (typeof this.options.devTools === 'function') {
      connect = this.options.devTools;
    }

    if (connect) {
      const defaultOptions = {
        name: this.id,
        features: {
          jump: false,
          skip: false
        }
      };

      this.devTools = connect({ ...defaultOptions, ...this.options.devToolsOptions });
      this.devTools.init(this.state);
    }
  }
}

export const spawnContext = {
  serviceStack: [] as Array<Interpreter<any, any>>
};

export function spawn(machine: StateMachine<any, any, any>, id?: string) {
  if (spawnContext.serviceStack.length) {
    const service =
      spawnContext.serviceStack[spawnContext.serviceStack.length - 1];
    const actor = service.spawn(machine, { id, subscribe: true });

    return { id: actor.id, parent: service.id, send: actor.send };
  }
}

/**
 * Creates a new Interpreter instance for the given machine with the provided options, if any.
 *
 * @param machine The machine to interpret
 * @param options Interpreter options
 */
export function interpret<
  TContext = DefaultContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject
>(
  machine: StateMachine<TContext, TStateSchema, TEvent>,
  options?: Partial<InterpreterOptions>
) {
  const interpreter = new Interpreter<TContext, TStateSchema, TEvent>(
    machine,
    options
  );

  return interpreter;
}
