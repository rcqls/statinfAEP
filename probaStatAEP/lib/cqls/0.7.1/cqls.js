(function(undefined) {
  if (typeof(this.Opal) !== 'undefined') {
    console.warn('Opal already loaded. Loading twice can cause troubles, please fix your setup.');
    return this.Opal;
  }

  // The Opal object that is exposed globally
  var Opal = this.Opal = {};

  // All bridged classes - keep track to donate methods from Object
  var bridged_classes = Opal.bridged_classes = [];

  // TopScope is used for inheriting constants from the top scope
  var TopScope = function(){};

  // Opal just acts as the top scope
  TopScope.prototype = Opal;

  // To inherit scopes
  Opal.constructor = TopScope;

  // List top scope constants
  Opal.constants = [];

  // This is a useful reference to global object inside ruby files
  Opal.global = this;

  // Minify common function calls
  var $hasOwn = Opal.hasOwnProperty;
  var $slice  = Opal.slice = Array.prototype.slice;

  // Generates unique id for every ruby object
  var unique_id = 0;

  // Return next unique id
  Opal.uid = function() {
    return unique_id++;
  };

  // Table holds all class variables
  Opal.cvars = {};

  // Globals table
  Opal.gvars = {};

  // Exit function, this should be replaced by platform specific implementation
  // (See nodejs and phantom for examples)
  Opal.exit = function(status) { if (Opal.gvars.DEBUG) console.log('Exited with status '+status); };

  /**
    Get a constant on the given scope. Every class and module in Opal has a
    scope used to store, and inherit, constants. For example, the top level
    `Object` in ruby has a scope accessible as `Opal.Object.$$scope`.

    To get the `Array` class using this scope, you could use:

        Opal.Object.$$scope.get("Array")

    If a constant with the given name cannot be found, then a dispatch to the
    class/module's `#const_method` is called, which by default will raise an
    error.

    @param [String] name the name of the constant to lookup
    @returns [RubyObject]
  */
  Opal.get = function(name) {
    var constant = this[name];

    if (constant == null) {
      return this.base.$const_missing(name);
    }

    return constant;
  };

  /*
   * Create a new constants scope for the given class with the given
   * base. Constants are looked up through their parents, so the base
   * scope will be the outer scope of the new klass.
   */
  function create_scope(base, klass, id) {
    var const_alloc = function() {};
    var const_scope = const_alloc.prototype = new base.constructor();

    klass.$$scope       = const_scope;
    klass.$$base_module = base.base;

    const_scope.base        = klass;
    const_scope.constructor = const_alloc;
    const_scope.constants   = [];

    if (id) {
      klass.$$orig_scope = base;
      base[id] = base.constructor[id] = klass;
      base.constants.push(id);
    }
  }

  Opal.create_scope = create_scope;

  /*
   * A `class Foo; end` expression in ruby is compiled to call this runtime
   * method which either returns an existing class of the given name, or creates
   * a new class in the given `base` scope.
   *
   * If a constant with the given name exists, then we check to make sure that
   * it is a class and also that the superclasses match. If either of these
   * fail, then we raise a `TypeError`. Note, superklass may be null if one was
   * not specified in the ruby code.
   *
   * We pass a constructor to this method of the form `function ClassName() {}`
   * simply so that classes show up with nicely formatted names inside debuggers
   * in the web browser (or node/sprockets).
   *
   * The `base` is the current `self` value where the class is being created
   * from. We use this to get the scope for where the class should be created.
   * If `base` is an object (not a class/module), we simple get its class and
   * use that as the base instead.
   *
   * @param [Object] base where the class is being created
   * @param [Class] superklass superclass of the new class (may be null)
   * @param [String] id the name of the class to be created
   * @param [Function] constructor function to use as constructor
   * @return [Class] new or existing ruby class
   */
  Opal.klass = function(base, superklass, id, constructor) {
    // If base is an object, use its class
    if (!base.$$is_class) {
      base = base.$$class;
    }

    // Not specifying a superclass means we can assume it to be Object
    if (superklass === null) {
      superklass = ObjectClass;
    }

    var klass = base.$$scope[id];

    // If a constant exists in the scope, then we must use that
    if ($hasOwn.call(base.$$scope, id) && klass.$$orig_scope === base.$$scope) {
      // Make sure the existing constant is a class, or raise error
      if (!klass.$$is_class) {
        throw Opal.TypeError.$new(id + " is not a class");
      }

      // Make sure existing class has same superclass
      if (superklass !== klass.$$super && superklass !== ObjectClass) {
        throw Opal.TypeError.$new("superclass mismatch for class " + id);
      }
    }
    else if (typeof(superklass) === 'function') {
      // passed native constructor as superklass, so bridge it as ruby class
      return bridge_class(id, superklass);
    }
    else {
      // if class doesnt exist, create a new one with given superclass
      klass = boot_class(superklass, constructor);

      // name class using base (e.g. Foo or Foo::Baz)
      klass.$$name = id;

      // every class gets its own constant scope, inherited from current scope
      create_scope(base.$$scope, klass, id);

      // Name new class directly onto current scope (Opal.Foo.Baz = klass)
      base[id] = base.$$scope[id] = klass;

      // Copy all parent constants to child, unless parent is Object
      if (superklass !== ObjectClass && superklass !== BasicObjectClass) {
        donate_constants(superklass, klass);
      }

      // call .inherited() hook with new class on the superclass
      if (superklass.$inherited) {
        superklass.$inherited(klass);
      }
    }

    return klass;
  };

  // Create generic class with given superclass.
  function boot_class(superklass, constructor) {
    var alloc = boot_class_alloc(null, constructor, superklass)

    return boot_class_object(superklass, alloc);
  }

  // Make `boot_class` available to the JS-API
  Opal.boot = boot_class;

  /*
   * The class object itself (as in `Class.new`)
   *
   * @param [(Opal) Class] superklass Another class object (as in `Class.new`)
   * @param [constructor]  alloc      The constructor that holds the prototype
   *                                  that will be used for instances of the
   *                                  newly constructed class.
   */
  function boot_class_object(superklass, alloc) {
    var singleton_class = function() {};
    singleton_class.prototype = superklass.constructor.prototype;

    function OpalClass() {}
    OpalClass.prototype = new singleton_class();

    var klass = new OpalClass();

    setup_module_or_class_object(klass, OpalClass, superklass, alloc.prototype);

    // @property $$alloc This is the constructor of instances of the current
    //                   class. Its prototype will be used for method lookup
    klass.$$alloc = alloc;

    // @property $$proto.$$class Make available to instances a reference to the
    //                           class they belong to.
    klass.$$proto.$$class = klass;

    return klass;
  }

  /*
   * Adds common/required properties to a module or class object
   * (as in `Module.new` / `Class.new`)
   *
   * @param module      The module or class that needs to be prepared
   *
   * @param constructor The constructor of the module or class itself,
   *                    usually it's already assigned by using `new`. Some
   *                    ipothesis on why it's needed can be found below.
   *
   * @param superklass  The superclass of the class/module object, for modules
   *                    is `Module` (of `ModuleClass` in JS context)
   *
   * @param prototype   The prototype on which the class/module methods will
   *                    be stored.
   */
  function setup_module_or_class_object(module, constructor, superklass, prototype) {
    // @property $$id Each class is assigned a unique `id` that helps
    //                comparation and implementation of `#object_id`
    module.$$id = unique_id++;

    // @property $$proto This is the prototype on which methods will be defined
    module.$$proto = prototype;

    // @property constructor keeps a ref to the constructor, but apparently the
    //                       constructor is already set on:
    //
    //                          `var module = new constructor` is called.
    //
    //                       Maybe there are some browsers not abiding (IE6?)
    module.constructor = constructor;

    // @property $$is_class Clearly mark this as a class-like
    module.$$is_class = true;

    // @property $$super the superclass, doesn't get changed by module inclusions
    module.$$super = superklass;

    // @property $$parent direct parent class or module
    //                    starts with the superclass, after module inclusion is
    //                    the last included module
    module.$$parent = superklass;

    // @property $$methods keeps track of methods defined on the class
    //                     but seems to be used just by `define_basic_object_method`
    //                     and for donating (Ruby) Object methods to bridged classes
    //                     TODO: check if it can be removed
    module.$$methods = [];

    // @property $$inc included modules
    module.$$inc = [];
  }

  /**
    Define new module (or return existing module). The given `base` is basically
    the current `self` value the `module` statement was defined in. If this is
    a ruby module or class, then it is used, otherwise if the base is a ruby
    object then that objects real ruby class is used (e.g. if the base is the
    main object, then the top level `Object` class is used as the base).

    If a module of the given name is already defined in the base, then that
    instance is just returned.

    If there is a class of the given name in the base, then an error is
    generated instead (cannot have a class and module of same name in same base).

    Otherwise, a new module is created in the base with the given name, and that
    new instance is returned back (to be referenced at runtime).

    @param [RubyModule or Class] base class or module this definition is inside
    @param [String] id the name of the new (or existing) module
    @returns [RubyModule]
  */
  Opal.module = function(base, id) {
    var module;

    if (!base.$$is_class) {
      base = base.$$class;
    }

    if ($hasOwn.call(base.$$scope, id)) {
      module = base.$$scope[id];

      if (!module.$$is_mod && module !== ObjectClass) {
        throw Opal.TypeError.$new(id + " is not a module");
      }
    }
    else {
      module = boot_module_object();
      module.$$name = id;

      create_scope(base.$$scope, module, id);

      // Name new module directly onto current scope (Opal.Foo.Baz = module)
      base[id] = base.$$scope[id] = module;
    }

    return module;
  };

  /*
   * Internal function to create a new module instance. This simply sets up
   * the prototype hierarchy and method tables.
   */
  function boot_module_object() {
    var mtor = function() {};
    mtor.prototype = ModuleClass.constructor.prototype;

    function module_constructor() {}
    module_constructor.prototype = new mtor();

    var module = new module_constructor();
    var module_prototype = {};

    setup_module_or_class_object(module, module_constructor, ModuleClass, module_prototype);

    module.$$is_mod = true;
    module.$$dep    = [];

    return module;
  }

  /**
    Return the singleton class for the passed object.

    If the given object alredy has a singleton class, then it will be stored on
    the object as the `$$meta` property. If this exists, then it is simply
    returned back.

    Otherwise, a new singleton object for the class or object is created, set on
    the object at `$$meta` for future use, and then returned.

    @param [RubyObject] object the ruby object
    @returns [RubyClass] the singleton class for object
  */
  Opal.get_singleton_class = function(object) {
    if (object.$$meta) {
      return object.$$meta;
    }

    if (object.$$is_class) {
      return build_class_singleton_class(object);
    }

    return build_object_singleton_class(object);
  };

  /**
    Build the singleton class for an existing class.

    NOTE: Actually in MRI a class' singleton class inherits from its
    superclass' singleton class which in turn inherits from Class.

    @param [RubyClass] klass
    @returns [RubyClass]
   */
  function build_class_singleton_class(klass) {
    var meta = new Opal.Class.$$alloc;

    meta.$$class = Opal.Class;
    meta.$$proto = klass.constructor.prototype;

    meta.$$is_singleton = true;
    meta.$$inc          = [];
    meta.$$methods      = [];
    meta.$$scope        = klass.$$scope;

    return klass.$$meta = meta;
  }

  /**
    Build the singleton class for a Ruby (non class) Object.

    @param [RubyObject] object
    @returns [RubyClass]
   */
  function build_object_singleton_class(object) {
    var orig_class = object.$$class,
        class_id   = "#<Class:#<" + orig_class.$$name + ":" + orig_class.$$id + ">>";

    var Singleton = function () {};
    var meta = Opal.boot(orig_class, Singleton);
    meta.$$name   = class_id;

    meta.$$proto  = object;
    meta.$$class  = orig_class.$$class;
    meta.$$scope  = orig_class.$$scope;
    meta.$$parent = orig_class;
    return object.$$meta = meta;
  }

  /**
    The actual inclusion of a module into a class.

    ## Class `$$parent` and `iclass`

    To handle `super` calls, every class has a `$$parent`. This parent is
    used to resolve the next class for a super call. A normal class would
    have this point to its superclass. However, if a class includes a module
    then this would need to take into account the module. The module would
    also have to then point its `$$parent` to the actual superclass. We
    cannot modify modules like this, because it might be included in more
    then one class. To fix this, we actually insert an `iclass` as the class'
    `$$parent` which can then point to the superclass. The `iclass` acts as
    a proxy to the actual module, so the `super` chain can then search it for
    the required method.

    @param [RubyModule] module the module to include
    @param [RubyClass] klass the target class to include module into
    @returns [null]
  */
  Opal.append_features = function(module, klass) {
    var included = klass.$$inc;

    // check if this module is already included in the klass
    for (var j = 0, jj = included.length; j < jj; j++) {
      if (included[j] === module) {
        return;
      }
    }

    included.push(module);
    module.$$dep.push(klass);

    // iclass
    var iclass = {
      $$name:   module.$$name,
      $$proto:  module.$$proto,
      $$parent: klass.$$parent,
      $$module: module,
      $$iclass: true
    };

    klass.$$parent = iclass;

    var donator   = module.$$proto,
        prototype = klass.$$proto,
        methods   = module.$$methods;

    for (var i = 0, length = methods.length; i < length; i++) {
      var method = methods[i], current;


      if ( prototype.hasOwnProperty(method) &&
          !(current = prototype[method]).$$donated && !current.$$stub ) {
        // if the target class already has a method of the same name defined
        // and that method was NOT donated, then it must be a method defined
        // by the class so we do not want to override it
      }
      else {
        prototype[method] = donator[method];
        prototype[method].$$donated = true;
      }
    }

    if (klass.$$dep) {
      donate_methods(klass, methods.slice(), true);
    }

    donate_constants(module, klass);
  };

  // Boot a base class (makes instances).
  function boot_class_alloc(id, constructor, superklass) {
    if (superklass) {
      var ctor = function() {};
          ctor.prototype   = superklass.$$proto || superklass.prototype;

      if (id) {
        ctor.displayName = id;
      }

      constructor.prototype = new ctor();
    }

    constructor.prototype.constructor = constructor;

    return constructor;
  }

  /*
   * Builds the class object for core classes:
   * - make the class object have a singleton class
   * - make the singleton class inherit from its parent singleton class
   *
   * @param id         [String]      the name of the class
   * @param alloc      [Function]    the constructor for the core class instances
   * @param superclass [Class alloc] the constructor of the superclass
   */
  function boot_core_class_object(id, alloc, superclass) {
    var superclass_constructor = function() {};
        superclass_constructor.prototype = superclass.prototype;

    var singleton_class = function() {};
        singleton_class.prototype = new superclass_constructor();

    singleton_class.displayName = "#<Class:"+id+">";

    // the singleton_class acts as the class object constructor
    var klass = new singleton_class();

    setup_module_or_class_object(klass, singleton_class, superclass, alloc.prototype);

    klass.$$alloc = alloc;
    klass.$$name  = id;

    // Give all instances a ref to their class
    alloc.prototype.$$class = klass;

    Opal[id] = klass;
    Opal.constants.push(id);

    return klass;
  }

  /*
   * For performance, some core ruby classes are toll-free bridged to their
   * native javascript counterparts (e.g. a ruby Array is a javascript Array).
   *
   * This method is used to setup a native constructor (e.g. Array), to have
   * its prototype act like a normal ruby class. Firstly, a new ruby class is
   * created using the native constructor so that its prototype is set as the
   * target for th new class. Note: all bridged classes are set to inherit
   * from Object.
   *
   * Bridged classes are tracked in `bridged_classes` array so that methods
   * defined on Object can be "donated" to all bridged classes. This allows
   * us to fake the inheritance of a native prototype from our Object
   * prototype.
   *
   * Example:
   *
   *    bridge_class("Proc", Function);
   *
   * @param [String] name the name of the ruby class to create
   * @param [Function] constructor native javascript constructor to use
   * @return [Class] returns new ruby class
   */
  function bridge_class(name, constructor) {
    var klass = boot_class_object(ObjectClass, constructor);

    klass.$$name = name;

    create_scope(Opal, klass, name);
    bridged_classes.push(klass);

    var object_methods = BasicObjectClass.$$methods.concat(ObjectClass.$$methods);

    for (var i = 0, len = object_methods.length; i < len; i++) {
      var meth = object_methods[i];
      constructor.prototype[meth] = ObjectClass.$$proto[meth];
    }

    add_stubs_subscriber(constructor.prototype);

    return klass;
  }

  /*
   * constant assign
   */
  Opal.casgn = function(base_module, name, value) {
    var scope = base_module.$$scope;

    if (value.$$is_class && value.$$name === nil) {
      value.$$name = name;
    }

    if (value.$$is_class) {
      value.$$base_module = base_module;
    }

    scope.constants.push(name);
    return scope[name] = value;
  };

  /*
   * constant decl
   */
  Opal.cdecl = function(base_scope, name, value) {
    base_scope.constants.push(name);
    return base_scope[name] = value;
  };

  /*
   * When a source module is included into the target module, we must also copy
   * its constants to the target.
   */
  function donate_constants(source_mod, target_mod) {
    var source_constants = source_mod.$$scope.constants,
        target_scope     = target_mod.$$scope,
        target_constants = target_scope.constants;

    for (var i = 0, length = source_constants.length; i < length; i++) {
      target_constants.push(source_constants[i]);
      target_scope[source_constants[i]] = source_mod.$$scope[source_constants[i]];
    }
  };

  /*
   * Methods stubs are used to facilitate method_missing in opal. A stub is a
   * placeholder function which just calls `method_missing` on the receiver.
   * If no method with the given name is actually defined on an object, then it
   * is obvious to say that the stub will be called instead, and then in turn
   * method_missing will be called.
   *
   * When a file in ruby gets compiled to javascript, it includes a call to
   * this function which adds stubs for every method name in the compiled file.
   * It should then be safe to assume that method_missing will work for any
   * method call detected.
   *
   * Method stubs are added to the BasicObject prototype, which every other
   * ruby object inherits, so all objects should handle method missing. A stub
   * is only added if the given property name (method name) is not already
   * defined.
   *
   * Note: all ruby methods have a `$` prefix in javascript, so all stubs will
   * have this prefix as well (to make this method more performant).
   *
   *    Opal.add_stubs(["$foo", "$bar", "$baz="]);
   *
   * All stub functions will have a private `$$stub` property set to true so
   * that other internal methods can detect if a method is just a stub or not.
   * `Kernel#respond_to?` uses this property to detect a methods presence.
   *
   * @param [Array] stubs an array of method stubs to add
   */
  Opal.add_stubs = function(stubs) {
    var subscribers = Opal.stub_subscribers;
    var subscriber;

    for (var i = 0, length = stubs.length; i < length; i++) {
      var method_name = stubs[i], stub = stub_for(method_name);

      for (var j = 0; j < subscribers.length; j++) {
        subscriber = subscribers[j];
        if (!(method_name in subscriber)) {
          subscriber[method_name] = stub;
        }
      }
    }
  };

  /*
   * Add a prototype to the subscribers list, and (TODO) add previously stubbed
   * methods.
   *
   * @param [Prototype]
   */
  function add_stubs_subscriber(prototype) {
    // TODO: Add previously stubbed methods too.
    Opal.stub_subscribers.push(prototype);
  }

  /*
   * Keep a list of prototypes that want method_missing stubs to be added.
   *
   * @default [Prototype List] BasicObject.prototype
   */
  Opal.stub_subscribers = [BasicObject.prototype];

  /*
   * Add a method_missing stub function to the given prototype for the
   * given name.
   *
   * @param [Prototype] prototype the target prototype
   * @param [String] stub stub name to add (e.g. "$foo")
   */
  function add_stub_for(prototype, stub) {
    var method_missing_stub = stub_for(stub);
    prototype[stub] = method_missing_stub;
  }

  /*
   * Generate the method_missing stub for a given method name.
   *
   * @param [String] method_name The js-name of the method to stub (e.g. "$foo")
   */
  function stub_for(method_name) {
    function method_missing_stub() {
      // Copy any given block onto the method_missing dispatcher
      this.$method_missing.$$p = method_missing_stub.$$p;

      // Set block property to null ready for the next call (stop false-positives)
      method_missing_stub.$$p = null;

      // call method missing with correct args (remove '$' prefix on method name)
      return this.$method_missing.apply(this, [method_name.slice(1)].concat($slice.call(arguments)));
    }

    method_missing_stub.$$stub = true;

    return method_missing_stub;
  }

  // Expose for other parts of Opal to use
  Opal.add_stub_for = add_stub_for;

  // Arity count error dispatcher
  Opal.ac = function(actual, expected, object, meth) {
    var inspect = (object.$$is_class ? object.$$name + '.' : object.$$class.$$name + '#') + meth;
    var msg = '[' + inspect + '] wrong number of arguments(' + actual + ' for ' + expected + ')';
    throw Opal.ArgumentError.$new(msg);
  };

  // Super dispatcher
  Opal.find_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    var dispatcher;

    if (defs) {
      dispatcher = obj.$$is_class ? defs.$$super : obj.$$class.$$proto;
    }
    else {
      if (obj.$$is_class) {
        dispatcher = obj.$$super;
      }
      else {
        dispatcher = find_obj_super_dispatcher(obj, jsid, current_func);
      }
    }

    dispatcher = dispatcher['$' + jsid];
    dispatcher.$$p = iter;

    return dispatcher;
  };

  // Iter dispatcher for super in a block
  Opal.find_iter_super_dispatcher = function(obj, jsid, current_func, iter, defs) {
    if (current_func.$$def) {
      return Opal.find_super_dispatcher(obj, current_func.$$jsid, current_func, iter, defs);
    }
    else {
      return Opal.find_super_dispatcher(obj, jsid, current_func, iter, defs);
    }
  };

  function find_obj_super_dispatcher(obj, jsid, current_func) {
    var klass = obj.$$meta || obj.$$class;
    jsid = '$' + jsid;

    while (klass) {
      if (klass.$$proto[jsid] === current_func) {
        // ok
        break;
      }

      klass = klass.$$parent;
    }

    // if we arent in a class, we couldnt find current?
    if (!klass) {
      throw new Error("could not find current class for super()");
    }

    klass = klass.$$parent;

    // else, let's find the next one
    while (klass) {
      var working = klass.$$proto[jsid];

      if (working && working !== current_func) {
        // ok
        break;
      }

      klass = klass.$$parent;
    }

    return klass.$$proto;
  };

  /*
   * Used to return as an expression. Sometimes, we can't simply return from
   * a javascript function as if we were a method, as the return is used as
   * an expression, or even inside a block which must "return" to the outer
   * method. This helper simply throws an error which is then caught by the
   * method. This approach is expensive, so it is only used when absolutely
   * needed.
   */
  Opal.ret = function(val) {
    Opal.returner.$v = val;
    throw Opal.returner;
  };

  // handles yield calls for 1 yielded arg
  Opal.yield1 = function(block, arg) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && arg.$$is_array) {
      return block.apply(null, arg);
    }
    else {
      return block(arg);
    }
  };

  // handles yield for > 1 yielded arg
  Opal.yieldX = function(block, args) {
    if (typeof(block) !== "function") {
      throw Opal.LocalJumpError.$new("no block given");
    }

    if (block.length > 1 && args.length == 1) {
      if (args[0].$$is_array) {
        return block.apply(null, args[0]);
      }
    }

    if (!args.$$is_array) {
      args = $slice.call(args);
    }

    return block.apply(null, args);
  };

  // Finds the corresponding exception match in candidates.  Each candidate can
  // be a value, or an array of values.  Returns null if not found.
  Opal.rescue = function(exception, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];

      if (candidate.$$is_array) {
        var result = Opal.rescue(exception, candidate);

        if (result) {
          return result;
        }
      }
      else if (candidate['$==='](exception)) {
        return candidate;
      }
    }

    return null;
  };

  Opal.is_a = function(object, klass) {
    if (object.$$meta === klass) {
      return true;
    }

    var search = object.$$class;

    while (search) {
      if (search === klass) {
        return true;
      }

      for (var i = 0, length = search.$$inc.length; i < length; i++) {
        if (search.$$inc[i] == klass) {
          return true;
        }
      }

      search = search.$$super;
    }

    return false;
  };

  // Helper to convert the given object to an array
  Opal.to_ary = function(value) {
    if (value.$$is_array) {
      return value;
    }
    else if (value.$to_ary && !value.$to_ary.$$stub) {
      return value.$to_ary();
    }

    return [value];
  };

  /**
    Used to get a list of rest keyword arguments. Method takes the given
    keyword args, i.e. the hash literal passed to the method containing all
    keyword arguemnts passed to method, as well as the used args which are
    the names of required and optional arguments defined. This method then
    just returns all key/value pairs which have not been used, in a new
    hash literal.

    @param given_args [Hash] all kwargs given to method
    @param used_args [Object<String: true>] all keys used as named kwargs
    @return [Hash]
   */
  Opal.kwrestargs = function(given_args, used_args) {
    var keys      = [],
        map       = {},
        key       = null,
        given_map = given_args.smap;

    for (key in given_map) {
      if (!used_args[key]) {
        keys.push(key);
        map[key] = given_map[key];
      }
    }

    return Opal.hash2(keys, map);
  };

  /*
   * Call a ruby method on a ruby object with some arguments:
   *
   *   var my_array = [1, 2, 3, 4]
   *   Opal.send(my_array, 'length')     # => 4
   *   Opal.send(my_array, 'reverse!')   # => [4, 3, 2, 1]
   *
   * A missing method will be forwarded to the object via
   * method_missing.
   *
   * The result of either call with be returned.
   *
   * @param [Object] recv the ruby object
   * @param [String] mid ruby method to call
   */
  Opal.send = function(recv, mid) {
    var args = $slice.call(arguments, 2),
        func = recv['$' + mid];

    if (func) {
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  Opal.block_send = function(recv, mid, block) {
    var args = $slice.call(arguments, 3),
        func = recv['$' + mid];

    if (func) {
      func.$$p = block;
      return func.apply(recv, args);
    }

    return recv.$method_missing.apply(recv, [mid].concat(args));
  };

  /*
   * Donate methods for a class/module
   */
  function donate_methods(klass, defined, indirect) {
    var methods = klass.$$methods, included_in = klass.$$dep;

    // if (!indirect) {
      klass.$$methods = methods.concat(defined);
    // }

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest     = includee.$$proto;

        for (var j = 0, jj = defined.length; j < jj; j++) {
          var method = defined[j];

          dest[method] = klass.$$proto[method];
          dest[method].$$donated = true;
        }

        if (includee.$$dep) {
          donate_methods(includee, defined, true);
        }
      }
    }
  };

  /**
    Define the given method on the module.

    This also handles donating methods to all classes that include this
    module. Method conflicts are also handled here, where a class might already
    have defined a method of the same name, or another included module defined
    the same method.

    @param [RubyModule] module the module method defined on
    @param [String] jsid javascript friendly method name (e.g. "$foo")
    @param [Function] body method body of actual function
  */
  function define_module_method(module, jsid, body) {
    module.$$proto[jsid] = body;
    body.$$owner = module;

    module.$$methods.push(jsid);

    if (module.$$module_function) {
      module[jsid] = body;
    }

    var included_in = module.$$dep;

    if (included_in) {
      for (var i = 0, length = included_in.length; i < length; i++) {
        var includee = included_in[i];
        var dest = includee.$$proto;
        var current = dest[jsid];


        if (dest.hasOwnProperty(jsid) && !current.$$donated && !current.$$stub) {
          // target class has already defined the same method name - do nothing
        }
        else if (dest.hasOwnProperty(jsid) && !current.$$stub) {
          // target class includes another module that has defined this method
          var klass_includees = includee.$$inc;

          for (var j = 0, jj = klass_includees.length; j < jj; j++) {
            if (klass_includees[j] === current.$$owner) {
              var current_owner_index = j;
            }
            if (klass_includees[j] === module) {
              var module_index = j;
            }
          }

          // only redefine method on class if the module was included AFTER
          // the module which defined the current method body. Also make sure
          // a module can overwrite a method it defined before
          if (current_owner_index <= module_index) {
            dest[jsid] = body;
            dest[jsid].$$donated = true;
          }
        }
        else {
          // neither a class, or module included by class, has defined method
          dest[jsid] = body;
          dest[jsid].$$donated = true;
        }

        if (includee.$$dep) {
          donate_methods(includee, [jsid], true);
        }
      }
    }
  }

  /**
    Used to define methods on an object. This is a helper method, used by the
    compiled source to define methods on special case objects when the compiler
    can not determine the destination object, or the object is a Module
    instance. This can get called by `Module#define_method` as well.

    ## Modules

    Any method defined on a module will come through this runtime helper.
    The method is added to the module body, and the owner of the method is
    set to be the module itself. This is used later when choosing which
    method should show on a class if more than 1 included modules define
    the same method. Finally, if the module is in `module_function` mode,
    then the method is also defined onto the module itself.

    ## Classes

    This helper will only be called for classes when a method is being
    defined indirectly; either through `Module#define_method`, or by a
    literal `def` method inside an `instance_eval` or `class_eval` body. In
    either case, the method is simply added to the class' prototype. A special
    exception exists for `BasicObject` and `Object`. These two classes are
    special because they are used in toll-free bridged classes. In each of
    these two cases, extra work is required to define the methods on toll-free
    bridged class' prototypes as well.

    ## Objects

    If a simple ruby object is the object, then the method is simply just
    defined on the object as a singleton method. This would be the case when
    a method is defined inside an `instance_eval` block.

    @param [RubyObject or Class] obj the actual obj to define method for
    @param [String] jsid the javascript friendly method name (e.g. '$foo')
    @param [Function] body the literal javascript function used as method
    @returns [null]
  */
  Opal.defn = function(obj, jsid, body) {
    if (obj.$$is_mod) {
      define_module_method(obj, jsid, body);
    }
    else if (obj.$$is_class) {
      obj.$$proto[jsid] = body;

      if (obj === BasicObjectClass) {
        define_basic_object_method(jsid, body);
      }
      else if (obj === ObjectClass) {
        donate_methods(obj, [jsid]);
      }
    }
    else {
      obj[jsid] = body;
    }

    return nil;
  };

  /*
   * Define a singleton method on the given object.
   */
  Opal.defs = function(obj, jsid, body) {
    if (obj.$$is_class || obj.$$is_mod) {
      obj.constructor.prototype[jsid] = body;
    }
    else {
      obj[jsid] = body;
    }
  };

  function define_basic_object_method(jsid, body) {
    BasicObjectClass.$$methods.push(jsid);
    for (var i = 0, len = bridged_classes.length; i < len; i++) {
      bridged_classes[i].$$proto[jsid] = body;
    }
  }

  Opal.hash = function() {
    if (arguments.length == 1 && arguments[0].$$class == Opal.Hash) {
      return arguments[0];
    }

    var hash = new Opal.Hash.$$alloc(),
        keys = [],
        _map = {},
        smap = {},
        key, obj, length, khash;

    hash.map   = _map;
    hash.smap  = smap;
    hash.keys  = keys;

    if (arguments.length == 1) {
      if (arguments[0].$$is_array) {
        var args = arguments[0];

        for (var i = 0, ii = args.length; i < ii; i++) {
          var pair = args[i];

          if (pair.length !== 2) {
            throw Opal.ArgumentError.$new("value not of length 2: " + pair.$inspect());
          }

          key = pair[0];
          obj = pair[1];

          if (key.$$is_string) {
            khash = key;
            map = smap;
          } else {
            khash = key.$hash();
            map = _map;
          }

          if (map[khash] == null) {
            keys.push(key);
          }

          map[khash] = obj;
        }
      }
      else {
        obj = arguments[0];
        for (key in obj) {
          khash = key.$hash();
          map[khash] = obj[khash];
          keys.push(key);
        }
      }
    }
    else {
      length = arguments.length;
      if (length % 2 !== 0) {
        throw Opal.ArgumentError.$new("odd number of arguments for Hash");
      }

      for (var j = 0; j < length; j++) {
        key = arguments[j];
        obj = arguments[++j];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        if (map[khash] == null) {
          keys.push(key);
        }

        map[khash] = obj;
      }
    }

    return hash;
  };

  /*
   * hash2 is a faster creator for hashes that just use symbols and
   * strings as keys. The map and keys array can be constructed at
   * compile time, so they are just added here by the constructor
   * function
   */
  Opal.hash2 = function(keys, map) {
    var hash = new Opal.Hash.$$alloc();

    hash.keys = keys;
    hash.map  = {};
    hash.smap = map;

    return hash;
  };

  /*
   * Create a new range instance with first and last values, and whether the
   * range excludes the last value.
   */
  Opal.range = function(first, last, exc) {
    var range         = new Opal.Range.$$alloc();
        range.begin   = first;
        range.end     = last;
        range.exclude = exc;

    return range;
  };

  // Require system
  // --------------
  (function(Opal) {
    var loaded_features = ['corelib/runtime.js'],
        require_table   = {'corelib/runtime.js': true},
        modules         = {};

    var current_dir  = '.';

    function mark_as_loaded(filename) {
      if (require_table[filename]) {
        return false;
      }

      loaded_features.push(filename);
      require_table[filename] = true;

      return true;
    }

    function normalize_loadable_path(path) {
      var parts, part, new_parts = [], SEPARATOR = '/';

      if (current_dir !== '.') {
        path = current_dir.replace(/\/*$/, '/') + path;
      }

      parts = path.split(SEPARATOR);

      for (var i = 0, ii = parts.length; i < ii; i++) {
        part = parts[i];
        if (part == '') continue;
        (part === '..') ? new_parts.pop() : new_parts.push(part)
      }

      return new_parts.join(SEPARATOR);
    }

    function load(path) {
      mark_as_loaded(path);

      var module = modules[path];

      if (module) {
        module(Opal);
      }
      else {
        var severity = Opal.dynamic_require_severity || 'warning';
        var message  = 'cannot load such file -- ' + path;

        if (severity === "error") {
          Opal.LoadError ? Opal.LoadError.$new(message) : function(){throw message}();
        }
        else if (severity === "warning") {
          console.warn('WARNING: LoadError: ' + message);
        }
      }

      return true;
    }

    function require(path) {
      if (require_table[path]) {
        return false;
      }

      return load(path);
    }

    Opal.modules         = modules;
    Opal.loaded_features = loaded_features;

    Opal.normalize_loadable_path = normalize_loadable_path;
    Opal.mark_as_loaded          = mark_as_loaded;

    Opal.load    = load;
    Opal.require = require;
  })(Opal);

  // Initialization
  // --------------

  // The actual class for BasicObject
  var BasicObjectClass;

  // The actual Object class
  var ObjectClass;

  // The actual Module class
  var ModuleClass;

  // The actual Class class
  var ClassClass;

  // Constructor for instances of BasicObject
  function BasicObject(){}

  // Constructor for instances of Object
  function Object(){}

  // Constructor for instances of Class
  function Class(){}

  // Constructor for instances of Module
  function Module(){}

  // Constructor for instances of NilClass (nil)
  function NilClass(){}

  // Constructors for *instances* of core objects
  boot_class_alloc('BasicObject', BasicObject);
  boot_class_alloc('Object',      Object,       BasicObject);
  boot_class_alloc('Module',      Module,       Object);
  boot_class_alloc('Class',       Class,        Module);

  // Constructors for *classes* of core objects
  BasicObjectClass = boot_core_class_object('BasicObject', BasicObject, Class);
  ObjectClass      = boot_core_class_object('Object',      Object,      BasicObjectClass.constructor);
  ModuleClass      = boot_core_class_object('Module',      Module,      ObjectClass.constructor);
  ClassClass       = boot_core_class_object('Class',       Class,       ModuleClass.constructor);

  // Fix booted classes to use their metaclass
  BasicObjectClass.$$class = ClassClass;
  ObjectClass.$$class      = ClassClass;
  ModuleClass.$$class      = ClassClass;
  ClassClass.$$class       = ClassClass;

  // Fix superclasses of booted classes
  BasicObjectClass.$$super = null;
  ObjectClass.$$super      = BasicObjectClass;
  ModuleClass.$$super      = ObjectClass;
  ClassClass.$$super       = ModuleClass;

  BasicObjectClass.$$parent = null;
  ObjectClass.$$parent      = BasicObjectClass;
  ModuleClass.$$parent      = ObjectClass;
  ClassClass.$$parent       = ModuleClass;

  // Internally, Object acts like a module as it is "included" into bridged
  // classes. In other words, we donate methods from Object into our bridged
  // classes as their prototypes don't inherit from our root Object, so they
  // act like module includes.
  ObjectClass.$$dep = bridged_classes;

  Opal.base                     = ObjectClass;
  BasicObjectClass.$$scope      = ObjectClass.$$scope = Opal;
  BasicObjectClass.$$orig_scope = ObjectClass.$$orig_scope = Opal;
  Opal.Kernel                   = ObjectClass;

  ModuleClass.$$scope      = ObjectClass.$$scope;
  ModuleClass.$$orig_scope = ObjectClass.$$orig_scope;
  ClassClass.$$scope       = ObjectClass.$$scope;
  ClassClass.$$orig_scope  = ObjectClass.$$orig_scope;

  ObjectClass.$$proto.toString = function() {
    return this.$to_s();
  };

  ObjectClass.$$proto.$require = Opal.require;

  Opal.top = new ObjectClass.$$alloc();

  // Nil
  var nil_id = Opal.uid(); // nil id is traditionally 4
  Opal.klass(ObjectClass, ObjectClass, 'NilClass', NilClass);
  var nil = Opal.nil = new NilClass();
  nil.$$id = nil_id;
  nil.call = nil.apply = function() { throw Opal.LocalJumpError.$new('no block given'); };

  Opal.breaker  = new Error('unexpected break');
  Opal.returner = new Error('unexpected return');

  bridge_class('Array',     Array);
  bridge_class('Boolean',   Boolean);
  bridge_class('Numeric',   Number);
  bridge_class('String',    String);
  bridge_class('Proc',      Function);
  bridge_class('Exception', Error);
  bridge_class('Regexp',    RegExp);
  bridge_class('Time',      Date);

  TypeError.$$super = Error;
}).call(this);

if (typeof(global) !== 'undefined') {
  global.Opal = this.Opal;
  Opal.global = global;
}
if (typeof(window) !== 'undefined') {
  window.Opal = this.Opal;
  Opal.global = window;
}
Opal.mark_as_loaded(Opal.normalize_loadable_path("corelib/runtime"));
/* Generated by Opal 0.7.1 */
Opal.modules["corelib/helpers"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$new', '$class', '$===', '$respond_to?', '$raise', '$type_error', '$__send__', '$coerce_to', '$nil?', '$<=>', '$inspect']);
  return (function($base) {
    var self = $module($base, 'Opal');

    var def = self.$$proto, $scope = self.$$scope;

    Opal.defs(self, '$type_error', function(object, type, method, coerced) {
      var $a, $b, self = this;

      if (method == null) {
        method = nil
      }
      if (coerced == null) {
        coerced = nil
      }
      if ((($a = (($b = method !== false && method !== nil) ? coerced : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return $scope.get('TypeError').$new("can't convert " + (object.$class()) + " into " + (type) + " (" + (object.$class()) + "#" + (method) + " gives " + (coerced.$class()))
        } else {
        return $scope.get('TypeError').$new("no implicit conversion of " + (object.$class()) + " into " + (type))
      };
    });

    Opal.defs(self, '$coerce_to', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type))
      };
      return object.$__send__(method);
    });

    Opal.defs(self, '$coerce_to!', function(object, type, method) {
      var $a, self = this, coerced = nil;

      coerced = self.$coerce_to(object, type, method);
      if ((($a = type['$==='](coerced)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    Opal.defs(self, '$coerce_to?', function(object, type, method) {
      var $a, self = this, coerced = nil;

      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      coerced = self.$coerce_to(object, type, method);
      if ((($a = coerced['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if ((($a = type['$==='](coerced)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise(self.$type_error(object, type, method, coerced))
      };
      return coerced;
    });

    Opal.defs(self, '$try_convert', function(object, type, method) {
      var $a, self = this;

      if ((($a = type['$==='](object)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object};
      if ((($a = object['$respond_to?'](method)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return object.$__send__(method)
        } else {
        return nil
      };
    });

    Opal.defs(self, '$compare', function(a, b) {
      var $a, self = this, compare = nil;

      compare = a['$<=>'](b);
      if ((($a = compare === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (a.$class()) + " with " + (b.$class()) + " failed")};
      return compare;
    });

    Opal.defs(self, '$destructure', function(args) {
      var self = this;

      
      if (args.length == 1) {
        return args[0];
      }
      else if (args.$$is_array) {
        return args;
      }
      else {
        return $slice.call(args);
      }
    
    });

    Opal.defs(self, '$respond_to?', function(obj, method) {
      var self = this;

      
      if (obj == null || !obj.$$class) {
        return false;
      }
    
      return obj['$respond_to?'](method);
    });

    Opal.defs(self, '$inspect', function(obj) {
      var self = this;

      
      if (obj === undefined) {
        return "undefined";
      }
      else if (obj === null) {
        return "null";
      }
      else if (!obj.$$class) {
        return obj.toString();
      }
      else {
        return obj.$inspect();
      }
    
    });
  })(self)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/module"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$attr_reader', '$attr_writer', '$coerce_to!', '$raise', '$=~', '$const_missing', '$const_get', '$to_str', '$to_proc', '$append_features', '$included', '$name', '$new', '$to_s', '$__id__']);
  return (function($base, $super) {
    function $Module(){};
    var self = $Module = $klass($base, $super, 'Module', $Module);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    Opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      function AnonModule(){}
      var klass      = Opal.boot(Opal.Module, AnonModule);
      klass.$$name   = nil;
      klass.$$class  = Opal.Module;
      klass.$$dep    = []
      klass.$$is_mod = true;
      klass.$$proto  = {};

      // inherit scope from parent
      Opal.create_scope(Opal.Module.$$scope, klass);

      if (block !== nil) {
        var block_self = block.$$s;
        block.$$s = null;
        block.call(klass);
        block.$$s = block_self;
      }

      return klass;
    
    });

    def['$==='] = function(object) {
      var $a, self = this;

      if ((($a = object == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return false};
      return Opal.is_a(object, self);
    };

    def['$<'] = function(other) {
      var self = this;

      
      var working = self;

      while (working) {
        if (working === other) {
          return true;
        }

        working = working.$$parent;
      }

      return false;
    
    };

    def.$alias_method = function(newname, oldname) {
      var self = this;

      
      var newjsid = '$' + newname,
          body    = self.$$proto['$' + oldname];

      if (self.$$is_singleton) {
        self.$$proto[newjsid] = body;
      }
      else {
        Opal.defn(self, newjsid, body);
      }

      return self;
    
      return self;
    };

    def.$alias_native = function(mid, jsid) {
      var self = this;

      if (jsid == null) {
        jsid = mid
      }
      return self.$$proto['$' + mid] = self.$$proto[jsid];
    };

    def.$ancestors = function() {
      var self = this;

      
      var parent = self,
          result = [];

      while (parent) {
        result.push(parent);
        result = result.concat(parent.$$inc);

        parent = parent.$$super;
      }

      return result;
    
    };

    def.$append_features = function(klass) {
      var self = this;

      Opal.append_features(self, klass);
      return self;
    };

    def.$attr_accessor = function(names) {
      var $a, $b, self = this;

      names = $slice.call(arguments, 0);
      ($a = self).$attr_reader.apply($a, [].concat(names));
      return ($b = self).$attr_writer.apply($b, [].concat(names));
    };

    def.$attr_reader = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          self.$$proto[name] = nil;
          var func = function() { return this[name] };

          if (self.$$is_singleton) {
            self.$$proto.constructor.prototype['$' + name] = func;
          }
          else {
            Opal.defn(self, '$' + name, func);
          }
        })(names[i]);
      }
    
      return nil;
    };

    def.$attr_writer = function(names) {
      var self = this;

      names = $slice.call(arguments, 0);
      
      for (var i = 0, length = names.length; i < length; i++) {
        (function(name) {
          self.$$proto[name] = nil;
          var func = function(value) { return this[name] = value; };

          if (self.$$is_singleton) {
            self.$$proto.constructor.prototype['$' + name + '='] = func;
          }
          else {
            Opal.defn(self, '$' + name + '=', func);
          }
        })(names[i]);
      }
    
      return nil;
    };

    Opal.defn(self, '$attr', def.$attr_accessor);

    def.$autoload = function(const$, path) {
      var self = this;

      
      var autoloaders;

      if (!(autoloaders = self.$$autoload)) {
        autoloaders = self.$$autoload = {};
      }

      autoloaders[const$] = path;
      return nil;
    ;
    };

    def.$class_variable_get = function(name) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'), "class vars should start with @@")};
      
      var value = Opal.cvars[name.slice(2)];
      (function() {if ((($a = value == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$raise($scope.get('NameError'), "uninitialized class variable @@a in")
        } else {
        return nil
      }; return nil; })()
      return value;
    
    };

    def.$class_variable_set = function(name, value) {
      var $a, self = this;

      name = $scope.get('Opal')['$coerce_to!'](name, $scope.get('String'), "to_str");
      if ((($a = name.length < 3 || name.slice(0,2) !== '@@') !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('NameError'))};
      
      Opal.cvars[name.slice(2)] = value;
      return value;
    
    };

    def.$constants = function() {
      var self = this;

      return self.$$scope.constants;
    };

    def['$const_defined?'] = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      
      scopes = [self.$$scope];
      if (inherit || self === Opal.Object) {
        var parent = self.$$super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);
          parent = parent.$$super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return true;
        }
      }

      return false;
    
    };

    def.$const_get = function(name, inherit) {
      var $a, self = this;

      if (inherit == null) {
        inherit = true
      }
      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      
      var scopes = [self.$$scope];
      if (inherit || self == Opal.Object) {
        var parent = self.$$super;
        while (parent !== Opal.BasicObject) {
          scopes.push(parent.$$scope);
          parent = parent.$$super;
        }
      }

      for (var i = 0, len = scopes.length; i < len; i++) {
        if (scopes[i].hasOwnProperty(name)) {
          return scopes[i][name];
        }
      }

      return self.$const_missing(name);
    
    };

    def.$const_missing = function(const$) {
      var self = this;

      
      if (self.$$autoload) {
        var file = self.$$autoload[const$];

        if (file) {
          self.$require(file);

          return self.$const_get(const$);
        }
      }
    ;
      return self.$raise($scope.get('NameError'), "uninitialized constant " + (self) + "::" + (const$));
    };

    def.$const_set = function(name, value) {
      var $a, self = this;

      if ((($a = name['$=~'](/^[A-Z]\w*$/)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "wrong constant name " + (name))
      };
      try {
      name = name.$to_str()
      } catch ($err) {if (true) {
        self.$raise($scope.get('TypeError'), "conversion with #to_str failed")
        }else { throw $err; }
      };
      Opal.casgn(self, name, value);
      return value;
    };

    def.$define_method = TMP_2 = function(name, method) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      
      if (method) {
        block = method.$to_proc();
      }

      if (block === nil) {
        throw new Error("no block given");
      }

      var jsid    = '$' + name;
      block.$$jsid = name;
      block.$$s    = null;
      block.$$def  = block;

      if (self.$$is_singleton) {
        self.$$proto[jsid] = block;
      }
      else {
        Opal.defn(self, jsid, block);
      }

      return name;
    ;
    };

    def.$remove_method = function(name) {
      var self = this;

      
      var jsid    = '$' + name;
      var current = self.$$proto[jsid];
      delete self.$$proto[jsid];

      // Check if we need to reverse Opal.donate
      // Opal.retire(self, [jsid]);
      return self;
    
    };

    def.$include = function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        if (mod === self) {
          continue;
        }

        (mod).$append_features(self);
        (mod).$included(self);
      }
    
      return self;
    };

    def['$include?'] = function(mod) {
      var self = this;

      
      for (var cls = self; cls; cls = cls.parent) {
        for (var i = 0; i != cls.$$inc.length; i++) {
          var mod2 = cls.$$inc[i];
          if (mod === mod2) {
            return true;
          }
        }
      }
      return false;
    
    };

    def.$instance_method = function(name) {
      var self = this;

      
      var meth = self.$$proto['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError'), "undefined method `" + (name) + "' for class `" + (self.$name()) + "'");
      }

      return $scope.get('UnboundMethod').$new(self, meth, name);
    
    };

    def.$instance_methods = function(include_super) {
      var self = this;

      if (include_super == null) {
        include_super = false
      }
      
      var methods = [],
          proto   = self.$$proto;

      for (var prop in proto) {
        if (!prop.charAt(0) === '$') {
          continue;
        }

        if (typeof(proto[prop]) !== "function") {
          continue;
        }

        if (proto[prop].$$stub) {
          continue;
        }

        if (!self.$$is_mod) {
          if (self !== Opal.BasicObject && proto[prop] === Opal.BasicObject.$$proto[prop]) {
            continue;
          }

          if (!include_super && !proto.hasOwnProperty(prop)) {
            continue;
          }

          if (!include_super && proto[prop].$$donated) {
            continue;
          }
        }

        methods.push(prop.substr(1));
      }

      return methods;
    
    };

    def.$included = function(mod) {
      var self = this;

      return nil;
    };

    def.$extended = function(mod) {
      var self = this;

      return nil;
    };

    def.$module_eval = TMP_3 = function() {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.call(self);
      block.$$s = old;

      return result;
    
    };

    Opal.defn(self, '$class_eval', def.$module_eval);

    def.$module_exec = TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      
      if (block === nil) {
        throw new Error("no block given");
      }

      var block_self = block.$$s, result;

      block.$$s = null;
      result = block.apply(self, $slice.call(arguments));
      block.$$s = block_self;

      return result;
    
    };

    Opal.defn(self, '$class_exec', def.$module_exec);

    def['$method_defined?'] = function(method) {
      var self = this;

      
      var body = self.$$proto['$' + method];
      return (!!body) && !body.$$stub;
    
    };

    def.$module_function = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      if (methods.length === 0) {
        self.$$module_function = true;
      }
      else {
        for (var i = 0, length = methods.length; i < length; i++) {
          var meth = methods[i], func = self.$$proto['$' + meth];

          self.constructor.prototype['$' + meth] = func;
        }
      }

      return self;
    
    };

    def.$name = function() {
      var self = this;

      
      if (self.$$full_name) {
        return self.$$full_name;
      }

      var result = [], base = self;

      while (base) {
        if (base.$$name === nil) {
          return result.length === 0 ? nil : result.join('::');
        }

        result.unshift(base.$$name);

        base = base.$$base_module;

        if (base === Opal.Object) {
          break;
        }
      }

      if (result.length === 0) {
        return nil;
      }

      return self.$$full_name = result.join('::');
    
    };

    def.$public = function(methods) {
      var self = this;

      methods = $slice.call(arguments, 0);
      
      if (methods.length === 0) {
        self.$$module_function = false;
      }

      return nil;
    
    };

    Opal.defn(self, '$private', def.$public);

    Opal.defn(self, '$protected', def.$public);

    Opal.defn(self, '$nesting', def.$public);

    def.$private_class_method = function(name) {
      var self = this;

      return self['$' + name] || nil;
    };

    Opal.defn(self, '$public_class_method', def.$private_class_method);

    def['$private_method_defined?'] = function(obj) {
      var self = this;

      return false;
    };

    def.$private_constant = function() {
      var self = this;

      return nil;
    };

    Opal.defn(self, '$protected_method_defined?', def['$private_method_defined?']);

    Opal.defn(self, '$public_instance_methods', def.$instance_methods);

    Opal.defn(self, '$public_method_defined?', def['$method_defined?']);

    def.$remove_class_variable = function() {
      var self = this;

      return nil;
    };

    def.$remove_const = function(name) {
      var self = this;

      
      var old = self.$$scope[name];
      delete self.$$scope[name];
      return old;
    
    };

    def.$to_s = function() {
      var $a, self = this;

      return ((($a = self.$name()) !== false && $a !== nil) ? $a : "#<" + (self.$$is_mod ? 'Module' : 'Class') + ":0x" + (self.$__id__().$to_s(16)) + ">");
    };

    return (def.$undef_method = function(symbol) {
      var self = this;

      Opal.add_stub_for(self.$$proto, "$" + symbol);
      return self;
    }, nil) && 'undef_method';
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/class"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$raise', '$allocate']);
  self.$require("corelib/module");
  return (function($base, $super) {
    function $Class(){};
    var self = $Class = $klass($base, $super, 'Class', $Class);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2;

    Opal.defs(self, '$new', TMP_1 = function(sup) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      if (sup == null) {
        sup = $scope.get('Object')
      }
      TMP_1.$$p = null;
      
      if (!sup.$$is_class || sup.$$is_mod) {
        self.$raise($scope.get('TypeError'), "superclass must be a Class");
      }

      function AnonClass(){};
      var klass      = Opal.boot(sup, AnonClass)
      klass.$$name   = nil;
      klass.$$parent = sup;

      // inherit scope from parent
      Opal.create_scope(sup.$$scope, klass);

      sup.$inherited(klass);

      if (block !== nil) {
        var block_self = block.$$s;
        block.$$s = null;
        block.call(klass);
        block.$$s = block_self;
      }

      return klass;
    ;
    });

    def.$allocate = function() {
      var self = this;

      
      var obj = new self.$$alloc;
      obj.$$id = Opal.uid();
      return obj;
    
    };

    def.$inherited = function(cls) {
      var self = this;

      return nil;
    };

    def.$new = TMP_2 = function(args) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      
      var obj = self.$allocate();

      obj.$initialize.$$p = block;
      obj.$initialize.apply(obj, args);
      return obj;
    ;
    };

    return (def.$superclass = function() {
      var self = this;

      return self.$$super || nil;
    }, nil) && 'superclass';
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/basic_object"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise', '$inspect']);
  return (function($base, $super) {
    function $BasicObject(){};
    var self = $BasicObject = $klass($base, $super, 'BasicObject', $BasicObject);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    Opal.defn(self, '$initialize', function() {
      var self = this;

      return nil;
    });

    Opal.defn(self, '$==', function(other) {
      var self = this;

      return self === other;
    });

    Opal.defn(self, '$__id__', function() {
      var self = this;

      return self.$$id || (self.$$id = Opal.uid());
    });

    Opal.defn(self, '$__send__', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      
      var func = self['$' + symbol]

      if (func) {
        if (block !== nil) {
          func.$$p = block;
        }

        return func.apply(self, args);
      }

      if (block !== nil) {
        self.$method_missing.$$p = block;
      }

      return self.$method_missing.apply(self, [symbol].concat(args));
    
    });

    Opal.defn(self, '$!', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$equal?', def['$==']);

    Opal.defn(self, '$instance_eval', TMP_2 = function() {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var old = block.$$s,
          result;

      block.$$s = null;
      result = block.call(self, self);
      block.$$s = old;

      return result;
    
    });

    Opal.defn(self, '$instance_exec', TMP_3 = function(args) {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        $scope.get('Kernel').$raise($scope.get('ArgumentError'), "no block given")
      };
      
      var block_self = block.$$s,
          result;

      block.$$s = null;
      result = block.apply(self, args);
      block.$$s = block_self;

      return result;
    
    });

    return (Opal.defn(self, '$method_missing', TMP_4 = function(symbol, args) {
      var $a, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_4.$$p = null;
      return $scope.get('Kernel').$raise($scope.get('NoMethodError'), (function() {if ((($a = self.$inspect && !self.$inspect.$$stub) !== nil && (!$a.$$is_boolean || $a == true))) {
        return "undefined method `" + (symbol) + "' for " + (self.$inspect()) + ":" + (self.$$class)
        } else {
        return "undefined method `" + (symbol) + "' for " + (self.$$class)
      }; return nil; })());
    }), nil) && 'method_missing';
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/kernel"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $gvars = Opal.gvars;

  Opal.add_stubs(['$raise', '$inspect', '$==', '$class', '$new', '$respond_to?', '$to_ary', '$to_a', '$<<', '$allocate', '$copy_instance_variables', '$initialize_clone', '$initialize_copy', '$singleton_class', '$initialize_dup', '$for', '$to_proc', '$each', '$reverse', '$append_features', '$extended', '$to_i', '$to_s', '$to_f', '$*', '$__id__', '$===', '$empty?', '$ArgumentError', '$nan?', '$infinite?', '$to_int', '$coerce_to!', '$>', '$length', '$print', '$format', '$puts', '$<=', '$[]', '$nil?', '$is_a?', '$rand', '$coerce_to', '$respond_to_missing?', '$try_convert!', '$expand_path', '$join', '$start_with?']);
  return (function($base) {
    var self = $module($base, 'Kernel');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_10;

    Opal.defn(self, '$method_missing', TMP_1 = function(symbol, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      return self.$raise($scope.get('NoMethodError'), "undefined method `" + (symbol) + "' for " + (self.$inspect()));
    });

    Opal.defn(self, '$=~', function(obj) {
      var self = this;

      return false;
    });

    Opal.defn(self, '$===', function(other) {
      var self = this;

      return self['$=='](other);
    });

    Opal.defn(self, '$<=>', function(other) {
      var self = this;

      
      if (self['$=='](other)) {
        return 0;
      }

      return nil;
    ;
    });

    Opal.defn(self, '$method', function(name) {
      var self = this;

      
      var meth = self['$' + name];

      if (!meth || meth.$$stub) {
        self.$raise($scope.get('NameError'), "undefined method `" + (name) + "' for class `" + (self.$class()) + "'");
      }

      return $scope.get('Method').$new(self, meth, name);
    
    });

    Opal.defn(self, '$methods', function(all) {
      var self = this;

      if (all == null) {
        all = true
      }
      
      var methods = [];

      for (var key in self) {
        if (key[0] == "$" && typeof(self[key]) === "function") {
          if (all == false || all === nil) {
            if (!Opal.hasOwnProperty.call(self, key)) {
              continue;
            }
          }
          if (self[key].$$stub === undefined) {
            methods.push(key.substr(1));
          }
        }
      }

      return methods;
    
    });

    Opal.defn(self, '$Array', TMP_2 = function(object, args) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_2.$$p = null;
      
      if (object == null || object === nil) {
        return [];
      }
      else if (object['$respond_to?']("to_ary")) {
        return object.$to_ary();
      }
      else if (object['$respond_to?']("to_a")) {
        return object.$to_a();
      }
      else {
        return [object];
      }
    ;
    });

    Opal.defn(self, '$at_exit', TMP_3 = function() {
      var $a, self = this, $iter = TMP_3.$$p, block = $iter || nil;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      TMP_3.$$p = null;
      ((($a = $gvars.__at_exit__) !== false && $a !== nil) ? $a : $gvars.__at_exit__ = []);
      return $gvars.__at_exit__['$<<'](block);
    });

    Opal.defn(self, '$caller', function() {
      var self = this;

      return [];
    });

    Opal.defn(self, '$class', function() {
      var self = this;

      return self.$$class;
    });

    Opal.defn(self, '$copy_instance_variables', function(other) {
      var self = this;

      
      for (var name in other) {
        if (name.charAt(0) !== '$') {
          self[name] = other[name];
        }
      }
    
    });

    Opal.defn(self, '$clone', function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_clone(self);
      return copy;
    });

    Opal.defn(self, '$initialize_clone', function(other) {
      var self = this;

      return self.$initialize_copy(other);
    });

    Opal.defn(self, '$define_singleton_method', TMP_4 = function(name) {
      var self = this, $iter = TMP_4.$$p, body = $iter || nil;

      TMP_4.$$p = null;
      if (body !== false && body !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create Proc object without a block")
      };
      
      var jsid   = '$' + name;
      body.$$jsid = name;
      body.$$s    = null;
      body.$$def  = body;

      self.$singleton_class().$$proto[jsid] = body;

      return self;
    
    });

    Opal.defn(self, '$dup', function() {
      var self = this, copy = nil;

      copy = self.$class().$allocate();
      copy.$copy_instance_variables(self);
      copy.$initialize_dup(self);
      return copy;
    });

    Opal.defn(self, '$initialize_dup', function(other) {
      var self = this;

      return self.$initialize_copy(other);
    });

    Opal.defn(self, '$enum_for', TMP_5 = function(method, args) {
      var $a, $b, self = this, $iter = TMP_5.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      if (method == null) {
        method = "each"
      }
      TMP_5.$$p = null;
      return ($a = ($b = $scope.get('Enumerator')).$for, $a.$$p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
    });

    Opal.defn(self, '$to_enum', def.$enum_for);

    Opal.defn(self, '$equal?', function(other) {
      var self = this;

      return self === other;
    });

    Opal.defn(self, '$exit', function(status) {
      var $a, $b, self = this;
      if ($gvars.__at_exit__ == null) $gvars.__at_exit__ = nil;

      if (status == null) {
        status = true
      }
      if ((($a = $gvars.__at_exit__) !== nil && (!$a.$$is_boolean || $a == true))) {
        ($a = ($b = $gvars.__at_exit__.$reverse()).$each, $a.$$p = "call".$to_proc(), $a).call($b)};
      if ((($a = status === true) !== nil && (!$a.$$is_boolean || $a == true))) {
        status = 0};
      Opal.exit(status);
      return nil;
    });

    Opal.defn(self, '$extend', function(mods) {
      var self = this;

      mods = $slice.call(arguments, 0);
      
      var singleton = self.$singleton_class();

      for (var i = mods.length - 1; i >= 0; i--) {
        var mod = mods[i];

        (mod).$append_features(singleton);
        (mod).$extended(self);
      }
    ;
      return self;
    });

    Opal.defn(self, '$format', function(format, args) {
      var self = this;

      args = $slice.call(arguments, 1);
      
      var idx = 0;
      return format.replace(/%(\d+\$)?([-+ 0]*)(\d*|\*(\d+\$)?)(?:\.(\d*|\*(\d+\$)?))?([cspdiubBoxXfgeEG])|(%%)/g, function(str, idx_str, flags, width_str, w_idx_str, prec_str, p_idx_str, spec, escaped) {
        if (escaped) {
          return '%';
        }

        var width,
        prec,
        is_integer_spec = ("diubBoxX".indexOf(spec) != -1),
        is_float_spec = ("eEfgG".indexOf(spec) != -1),
        prefix = '',
        obj;

        if (width_str === undefined) {
          width = undefined;
        } else if (width_str.charAt(0) == '*') {
          var w_idx = idx++;
          if (w_idx_str) {
            w_idx = parseInt(w_idx_str, 10) - 1;
          }
          width = (args[w_idx]).$to_i();
        } else {
          width = parseInt(width_str, 10);
        }
        if (!prec_str) {
          prec = is_float_spec ? 6 : undefined;
        } else if (prec_str.charAt(0) == '*') {
          var p_idx = idx++;
          if (p_idx_str) {
            p_idx = parseInt(p_idx_str, 10) - 1;
          }
          prec = (args[p_idx]).$to_i();
        } else {
          prec = parseInt(prec_str, 10);
        }
        if (idx_str) {
          idx = parseInt(idx_str, 10) - 1;
        }
        switch (spec) {
        case 'c':
          obj = args[idx];
          if (obj.$$is_string) {
            str = obj.charAt(0);
          } else {
            str = String.fromCharCode((obj).$to_i());
          }
          break;
        case 's':
          str = (args[idx]).$to_s();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'p':
          str = (args[idx]).$inspect();
          if (prec !== undefined) {
            str = str.substr(0, prec);
          }
          break;
        case 'd':
        case 'i':
        case 'u':
          str = (args[idx]).$to_i().toString();
          break;
        case 'b':
        case 'B':
          str = (args[idx]).$to_i().toString(2);
          break;
        case 'o':
          str = (args[idx]).$to_i().toString(8);
          break;
        case 'x':
        case 'X':
          str = (args[idx]).$to_i().toString(16);
          break;
        case 'e':
        case 'E':
          str = (args[idx]).$to_f().toExponential(prec);
          break;
        case 'f':
          str = (args[idx]).$to_f().toFixed(prec);
          break;
        case 'g':
        case 'G':
          str = (args[idx]).$to_f().toPrecision(prec);
          break;
        }
        idx++;
        if (is_integer_spec || is_float_spec) {
          if (str.charAt(0) == '-') {
            prefix = '-';
            str = str.substr(1);
          } else {
            if (flags.indexOf('+') != -1) {
              prefix = '+';
            } else if (flags.indexOf(' ') != -1) {
              prefix = ' ';
            }
          }
        }
        if (is_integer_spec && prec !== undefined) {
          if (str.length < prec) {
            str = "0"['$*'](prec - str.length) + str;
          }
        }
        var total_len = prefix.length + str.length;
        if (width !== undefined && total_len < width) {
          if (flags.indexOf('-') != -1) {
            str = str + " "['$*'](width - total_len);
          } else {
            var pad_char = ' ';
            if (flags.indexOf('0') != -1) {
              str = "0"['$*'](width - total_len) + str;
            } else {
              prefix = " "['$*'](width - total_len) + prefix;
            }
          }
        }
        var result = prefix + str;
        if ('XEG'.indexOf(spec) != -1) {
          result = result.toUpperCase();
        }
        return result;
      });
    
    });

    Opal.defn(self, '$freeze', function() {
      var self = this;

      self.___frozen___ = true;
      return self;
    });

    Opal.defn(self, '$frozen?', function() {
      var $a, self = this;
      if (self.___frozen___ == null) self.___frozen___ = nil;

      return ((($a = self.___frozen___) !== false && $a !== nil) ? $a : false);
    });

    Opal.defn(self, '$hash', function() {
      var self = this;

      return [self.$$class.$$name,(self.$$class).$__id__(),self.$__id__()].join(':');
    });

    Opal.defn(self, '$initialize_copy', function(other) {
      var self = this;

      return nil;
    });

    Opal.defn(self, '$inspect', function() {
      var self = this;

      return self.$to_s();
    });

    Opal.defn(self, '$instance_of?', function(klass) {
      var self = this;

      return self.$$class === klass;
    });

    Opal.defn(self, '$instance_variable_defined?', function(name) {
      var self = this;

      return Opal.hasOwnProperty.call(self, name.substr(1));
    });

    Opal.defn(self, '$instance_variable_get', function(name) {
      var self = this;

      
      var ivar = self[name.substr(1)];

      return ivar == null ? nil : ivar;
    
    });

    Opal.defn(self, '$instance_variable_set', function(name, value) {
      var self = this;

      return self[name.substr(1)] = value;
    });

    Opal.defn(self, '$instance_variables', function() {
      var self = this;

      
      var result = [];

      for (var name in self) {
        if (name.charAt(0) !== '$') {
          if (name !== '$$class' && name !== '$$id') {
            result.push('@' + name);
          }
        }
      }

      return result;
    
    });

    Opal.defn(self, '$Integer', function(value, base) {
      var $a, $b, self = this, $case = nil;

      if (base == null) {
        base = nil
      }
      if ((($a = $scope.get('String')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = value['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "invalid value for Integer: (empty string)")};
        return parseInt(value, ((($a = base) !== false && $a !== nil) ? $a : undefined));};
      if (base !== false && base !== nil) {
        self.$raise(self.$ArgumentError("base is only valid for String values"))};
      return (function() {$case = value;if ($scope.get('Integer')['$===']($case)) {return value}else if ($scope.get('Float')['$===']($case)) {if ((($a = ((($b = value['$nan?']()) !== false && $b !== nil) ? $b : value['$infinite?']())) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('FloatDomainError'), "unable to coerce " + (value) + " to Integer")};
      return value.$to_int();}else if ($scope.get('NilClass')['$===']($case)) {return self.$raise($scope.get('TypeError'), "can't convert nil into Integer")}else {if ((($a = value['$respond_to?']("to_int")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return value.$to_int()
      } else if ((($a = value['$respond_to?']("to_i")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return value.$to_i()
        } else {
        return self.$raise($scope.get('TypeError'), "can't convert " + (value.$class()) + " into Integer")
      }}})();
    });

    Opal.defn(self, '$Float', function(value) {
      var $a, self = this;

      if ((($a = $scope.get('String')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return parseFloat(value);
      } else if ((($a = value['$respond_to?']("to_f")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return value.$to_f()
        } else {
        return self.$raise($scope.get('TypeError'), "can't convert " + (value.$class()) + " into Float")
      };
    });

    Opal.defn(self, '$is_a?', function(klass) {
      var self = this;

      return Opal.is_a(self, klass);
    });

    Opal.defn(self, '$kind_of?', def['$is_a?']);

    Opal.defn(self, '$lambda', TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      block.$$is_lambda = true;
      return block;
    });

    Opal.defn(self, '$load', function(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.load(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$loop', TMP_7 = function() {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      while (true) {
        if (block() === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    });

    Opal.defn(self, '$nil?', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$object_id', def.$__id__);

    Opal.defn(self, '$printf', function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      if (args.$length()['$>'](0)) {
        self.$print(($a = self).$format.apply($a, [].concat(args)))};
      return nil;
    });

    Opal.defn(self, '$private_methods', function() {
      var self = this;

      return [];
    });

    Opal.defn(self, '$private_instance_methods', def.$private_methods);

    Opal.defn(self, '$proc', TMP_8 = function() {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create Proc object without a block")
      };
      block.$$is_lambda = false;
      return block;
    });

    Opal.defn(self, '$puts', function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$puts.apply($a, [].concat(strs));
    });

    Opal.defn(self, '$p', function(args) {
      var $a, $b, TMP_9, self = this;

      args = $slice.call(arguments, 0);
      ($a = ($b = args).$each, $a.$$p = (TMP_9 = function(obj){var self = TMP_9.$$s || this;
        if ($gvars.stdout == null) $gvars.stdout = nil;
if (obj == null) obj = nil;
      return $gvars.stdout.$puts(obj.$inspect())}, TMP_9.$$s = self, TMP_9), $a).call($b);
      if (args.$length()['$<='](1)) {
        return args['$[]'](0)
        } else {
        return args
      };
    });

    Opal.defn(self, '$print', function(strs) {
      var $a, self = this;
      if ($gvars.stdout == null) $gvars.stdout = nil;

      strs = $slice.call(arguments, 0);
      return ($a = $gvars.stdout).$print.apply($a, [].concat(strs));
    });

    Opal.defn(self, '$warn', function(strs) {
      var $a, $b, self = this;
      if ($gvars.VERBOSE == null) $gvars.VERBOSE = nil;
      if ($gvars.stderr == null) $gvars.stderr = nil;

      strs = $slice.call(arguments, 0);
      if ((($a = ((($b = $gvars.VERBOSE['$nil?']()) !== false && $b !== nil) ? $b : strs['$empty?']())) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil
        } else {
        return ($a = $gvars.stderr).$puts.apply($a, [].concat(strs))
      };
    });

    Opal.defn(self, '$raise', function(exception, string) {
      var self = this;
      if ($gvars["!"] == null) $gvars["!"] = nil;

      
      if (exception == null && $gvars["!"]) {
        exception = $gvars["!"];
      }
      else if (exception.$$is_string) {
        exception = $scope.get('RuntimeError').$new(exception);
      }
      else if (!exception['$is_a?']($scope.get('Exception'))) {
        exception = exception.$new(string);
      }

      $gvars["!"] = exception;
      throw exception;
    ;
    });

    Opal.defn(self, '$fail', def.$raise);

    Opal.defn(self, '$rand', function(max) {
      var self = this;

      
      if (max === undefined) {
        return Math.random();
      }
      else if (max.$$is_range) {
        var arr = max.$to_a();

        return arr[self.$rand(arr.length)];
      }
      else {
        return Math.floor(Math.random() *
          Math.abs($scope.get('Opal').$coerce_to(max, $scope.get('Integer'), "to_int")));
      }
    
    });

    Opal.defn(self, '$respond_to?', function(name, include_all) {
      var $a, self = this;

      if (include_all == null) {
        include_all = false
      }
      if ((($a = self['$respond_to_missing?'](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      
      var body = self['$' + name];

      if (typeof(body) === "function" && !body.$$stub) {
        return true;
      }
    
      return false;
    });

    Opal.defn(self, '$respond_to_missing?', function(method_name) {
      var self = this;

      return false;
    });

    Opal.defn(self, '$require', function(file) {
      var self = this;

      file = $scope.get('Opal')['$coerce_to!'](file, $scope.get('String'), "to_str");
      return Opal.require(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$require_relative', function(file) {
      var self = this;

      $scope.get('Opal')['$try_convert!'](file, $scope.get('String'), "to_str");
      file = $scope.get('File').$expand_path($scope.get('File').$join(Opal.current_file, "..", file));
      return Opal.require(Opal.normalize_loadable_path(file));
    });

    Opal.defn(self, '$require_tree', function(path) {
      var self = this;

      path = $scope.get('File').$expand_path(path);
      
      for (var name in Opal.modules) {
        if ((name)['$start_with?'](path)) {
          Opal.require(name);
        }
      }
    ;
      return nil;
    });

    Opal.defn(self, '$send', def.$__send__);

    Opal.defn(self, '$public_send', def.$__send__);

    Opal.defn(self, '$singleton_class', function() {
      var self = this;

      return Opal.get_singleton_class(self);
    });

    Opal.defn(self, '$sprintf', def.$format);

    Opal.defn(self, '$srand', def.$rand);

    Opal.defn(self, '$String', function(str) {
      var self = this;

      return String(str);
    });

    Opal.defn(self, '$taint', function() {
      var self = this;

      return self;
    });

    Opal.defn(self, '$tainted?', function() {
      var self = this;

      return false;
    });

    Opal.defn(self, '$tap', TMP_10 = function() {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      if (Opal.yield1(block, self) === $breaker) return $breaker.$v;
      return self;
    });

    Opal.defn(self, '$to_proc', function() {
      var self = this;

      return self;
    });

    Opal.defn(self, '$to_s', function() {
      var self = this;

      return "#<" + (self.$class()) + ":0x" + (self.$__id__().$to_s(16)) + ">";
    });

    Opal.defn(self, '$untaint', def.$taint);
  })(self)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/nil_class"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise']);
  (function($base, $super) {
    function $NilClass(){};
    var self = $NilClass = $klass($base, $super, 'NilClass', $NilClass);

    var def = self.$$proto, $scope = self.$$scope;

    def['$!'] = function() {
      var self = this;

      return true;
    };

    def['$&'] = function(other) {
      var self = this;

      return false;
    };

    def['$|'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$^'] = function(other) {
      var self = this;

      return other !== false && other !== nil;
    };

    def['$=='] = function(other) {
      var self = this;

      return other === nil;
    };

    def.$dup = function() {
      var self = this;

      return self.$raise($scope.get('TypeError'));
    };

    def.$inspect = function() {
      var self = this;

      return "nil";
    };

    def['$nil?'] = function() {
      var self = this;

      return true;
    };

    def.$singleton_class = function() {
      var self = this;

      return $scope.get('NilClass');
    };

    def.$to_a = function() {
      var self = this;

      return [];
    };

    def.$to_h = function() {
      var self = this;

      return Opal.hash();
    };

    def.$to_i = function() {
      var self = this;

      return 0;
    };

    Opal.defn(self, '$to_f', def.$to_i);

    return (def.$to_s = function() {
      var self = this;

      return "";
    }, nil) && 'to_s';
  })(self, null);
  return Opal.cdecl($scope, 'NIL', nil);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/boolean"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$undef_method']);
  (function($base, $super) {
    function $Boolean(){};
    var self = $Boolean = $klass($base, $super, 'Boolean', $Boolean);

    var def = self.$$proto, $scope = self.$$scope;

    def.$$is_boolean = true;

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return self.$undef_method("new")
    })(self.$singleton_class());

    def['$!'] = function() {
      var self = this;

      return self != true;
    };

    def['$&'] = function(other) {
      var self = this;

      return (self == true) ? (other !== false && other !== nil) : false;
    };

    def['$|'] = function(other) {
      var self = this;

      return (self == true) ? true : (other !== false && other !== nil);
    };

    def['$^'] = function(other) {
      var self = this;

      return (self == true) ? (other === false || other === nil) : (other !== false && other !== nil);
    };

    def['$=='] = function(other) {
      var self = this;

      return (self == true) === other.valueOf();
    };

    Opal.defn(self, '$equal?', def['$==']);

    Opal.defn(self, '$singleton_class', def.$class);

    return (def.$to_s = function() {
      var self = this;

      return (self == true) ? 'true' : 'false';
    }, nil) && 'to_s';
  })(self, null);
  Opal.cdecl($scope, 'TrueClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'FalseClass', $scope.get('Boolean'));
  Opal.cdecl($scope, 'TRUE', true);
  return Opal.cdecl($scope, 'FALSE', false);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/error"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module;

  Opal.add_stubs(['$attr_reader', '$class']);
  (function($base, $super) {
    function $Exception(){};
    var self = $Exception = $klass($base, $super, 'Exception', $Exception);

    var def = self.$$proto, $scope = self.$$scope;

    def.message = nil;
    self.$attr_reader("message");

    Opal.defs(self, '$new', function(message) {
      var self = this;

      if (message == null) {
        message = "Exception"
      }
      
      var err = new self.$$alloc(message);

      if (Error.captureStackTrace) {
        Error.captureStackTrace(err);
      }

      err.name = self.$$name;
      err.$initialize(message);
      return err;
    
    });

    def.$initialize = function(message) {
      var self = this;

      return self.message = message;
    };

    def.$backtrace = function() {
      var self = this;

      
      var backtrace = self.stack;

      if (typeof(backtrace) === 'string') {
        return backtrace.split("\n").slice(0, 15);
      }
      else if (backtrace) {
        return backtrace.slice(0, 15);
      }

      return [];
    
    };

    def.$inspect = function() {
      var self = this;

      return "#<" + (self.$class()) + ": '" + (self.message) + "'>";
    };

    return Opal.defn(self, '$to_s', def.$message);
  })(self, null);
  (function($base, $super) {
    function $ScriptError(){};
    var self = $ScriptError = $klass($base, $super, 'ScriptError', $ScriptError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $SyntaxError(){};
    var self = $SyntaxError = $klass($base, $super, 'SyntaxError', $SyntaxError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $LoadError(){};
    var self = $LoadError = $klass($base, $super, 'LoadError', $LoadError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $NotImplementedError(){};
    var self = $NotImplementedError = $klass($base, $super, 'NotImplementedError', $NotImplementedError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('ScriptError'));
  (function($base, $super) {
    function $SystemExit(){};
    var self = $SystemExit = $klass($base, $super, 'SystemExit', $SystemExit);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $NoMemoryError(){};
    var self = $NoMemoryError = $klass($base, $super, 'NoMemoryError', $NoMemoryError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $SignalException(){};
    var self = $SignalException = $klass($base, $super, 'SignalException', $SignalException);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $Interrupt(){};
    var self = $Interrupt = $klass($base, $super, 'Interrupt', $Interrupt);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $StandardError(){};
    var self = $StandardError = $klass($base, $super, 'StandardError', $StandardError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Exception'));
  (function($base, $super) {
    function $NameError(){};
    var self = $NameError = $klass($base, $super, 'NameError', $NameError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $NoMethodError(){};
    var self = $NoMethodError = $klass($base, $super, 'NoMethodError', $NoMethodError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('NameError'));
  (function($base, $super) {
    function $RuntimeError(){};
    var self = $RuntimeError = $klass($base, $super, 'RuntimeError', $RuntimeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $LocalJumpError(){};
    var self = $LocalJumpError = $klass($base, $super, 'LocalJumpError', $LocalJumpError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $TypeError(){};
    var self = $TypeError = $klass($base, $super, 'TypeError', $TypeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $ArgumentError(){};
    var self = $ArgumentError = $klass($base, $super, 'ArgumentError', $ArgumentError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $IndexError(){};
    var self = $IndexError = $klass($base, $super, 'IndexError', $IndexError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $StopIteration(){};
    var self = $StopIteration = $klass($base, $super, 'StopIteration', $StopIteration);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('IndexError'));
  (function($base, $super) {
    function $KeyError(){};
    var self = $KeyError = $klass($base, $super, 'KeyError', $KeyError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('IndexError'));
  (function($base, $super) {
    function $RangeError(){};
    var self = $RangeError = $klass($base, $super, 'RangeError', $RangeError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $FloatDomainError(){};
    var self = $FloatDomainError = $klass($base, $super, 'FloatDomainError', $FloatDomainError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('RangeError'));
  (function($base, $super) {
    function $IOError(){};
    var self = $IOError = $klass($base, $super, 'IOError', $IOError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  (function($base, $super) {
    function $SystemCallError(){};
    var self = $SystemCallError = $klass($base, $super, 'SystemCallError', $SystemCallError);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('StandardError'));
  return (function($base) {
    var self = $module($base, 'Errno');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $EINVAL(){};
      var self = $EINVAL = $klass($base, $super, 'EINVAL', $EINVAL);

      var def = self.$$proto, $scope = self.$$scope, TMP_1;

      return (Opal.defs(self, '$new', TMP_1 = function() {
        var self = this, $iter = TMP_1.$$p, $yield = $iter || nil;

        TMP_1.$$p = null;
        return Opal.find_super_dispatcher(self, 'new', TMP_1, null, $EINVAL).apply(self, ["Invalid argument"]);
      }), nil) && 'new'
    })(self, $scope.get('SystemCallError'))
  })(self);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/regexp"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$nil?', '$[]', '$respond_to?', '$to_str', '$to_s', '$coerce_to', '$new', '$raise', '$class', '$call']);
  return (function($base, $super) {
    function $Regexp(){};
    var self = $Regexp = $klass($base, $super, 'Regexp', $Regexp);

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    def.$$is_regexp = true;

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$escape = function(string) {
        var self = this;

        
        return string.replace(/([-[\]\/{}()*+?.^$\\| ])/g, '\\$1')
                     .replace(/[\n]/g, '\\n')
                     .replace(/[\r]/g, '\\r')
                     .replace(/[\f]/g, '\\f')
                     .replace(/[\t]/g, '\\t');
      
      };
      self.$$proto.$last_match = function(n) {
        var $a, self = this;
        if ($gvars["~"] == null) $gvars["~"] = nil;

        if (n == null) {
          n = nil
        }
        if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return $gvars["~"]
          } else {
          return $gvars["~"]['$[]'](n)
        };
      };
      self.$$proto.$quote = self.$$proto.$escape;
      self.$$proto.$union = function(parts) {
        var self = this;

        parts = $slice.call(arguments, 0);
        return new RegExp(parts.join(''));
      };
      return (self.$$proto.$new = function(regexp, options) {
        var self = this;

        return new RegExp(regexp, options);
      }, nil) && 'new';
    })(self.$singleton_class());

    def['$=='] = function(other) {
      var self = this;

      return other.constructor == RegExp && self.toString() === other.toString();
    };

    def['$==='] = function(str) {
      var self = this;

      
      if (!str.$$is_string && str['$respond_to?']("to_str")) {
        str = str.$to_str();
      }

      if (!str.$$is_string) {
        return false;
      }

      return self.test(str);
    ;
    };

    def['$=~'] = function(string) {
      var $a, self = this;

      if ((($a = string === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        $gvars["~"] = nil;
        return nil;};
      string = $scope.get('Opal').$coerce_to(string, $scope.get('String'), "to_str").$to_s();
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        $gvars["~"] = $scope.get('MatchData').$new(re, result);

        return result.index;
      }
      else {
        $gvars["~"] = nil;
        return nil;
      }
    
    };

    Opal.defn(self, '$eql?', def['$==']);

    def.$inspect = function() {
      var self = this;

      return self.toString();
    };

    def.$match = TMP_1 = function(string, pos) {
      var $a, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if ((($a = string === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        $gvars["~"] = nil;
        return nil;};
      if ((($a = string.$$is_string == null) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = string['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.$raise($scope.get('TypeError'), "no implicit conversion of " + (string.$class()) + " into String")
        };
        string = string.$to_str();};
      
      var re = self;

      if (re.global) {
        // should we clear it afterwards too?
        re.lastIndex = 0;
      }
      else {
        re = new RegExp(re.source, 'g' + (re.multiline ? 'm' : '') + (re.ignoreCase ? 'i' : ''));
      }

      var result = re.exec(string);

      if (result) {
        result = $gvars["~"] = $scope.get('MatchData').$new(re, result);

        if (block === nil) {
          return result;
        }
        else {
          return block.$call(result);
        }
      }
      else {
        return $gvars["~"] = nil;
      }
    
    };

    def.$source = function() {
      var self = this;

      return self.source;
    };

    return Opal.defn(self, '$to_s', def.$source);
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/comparable"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$===', '$>', '$<', '$equal?', '$<=>', '$normalize', '$raise', '$class']);
  return (function($base) {
    var self = $module($base, 'Comparable');

    var def = self.$$proto, $scope = self.$$scope;

    Opal.defs(self, '$normalize', function(what) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](what)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return what};
      if (what['$>'](0)) {
        return 1};
      if (what['$<'](0)) {
        return -1};
      return 0;
    });

    Opal.defn(self, '$==', function(other) {
      var $a, self = this, cmp = nil;

      try {
      if ((($a = self['$equal?'](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return true};
        if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          return false
        };
        return $scope.get('Comparable').$normalize(cmp) == 0;
      } catch ($err) {if (Opal.rescue($err, [$scope.get('StandardError')])) {
        return false
        }else { throw $err; }
      };
    });

    Opal.defn(self, '$>', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) > 0;
    });

    Opal.defn(self, '$>=', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) >= 0;
    });

    Opal.defn(self, '$<', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) < 0;
    });

    Opal.defn(self, '$<=', function(other) {
      var $a, self = this, cmp = nil;

      if ((($a = cmp = (self['$<=>'](other))) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")
      };
      return $scope.get('Comparable').$normalize(cmp) <= 0;
    });

    Opal.defn(self, '$between?', function(min, max) {
      var self = this;

      if (self['$<'](min)) {
        return false};
      if (self['$>'](max)) {
        return false};
      return true;
    });
  })(self)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/enumerable"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module;

  Opal.add_stubs(['$raise', '$enum_for', '$flatten', '$map', '$==', '$destructure', '$nil?', '$coerce_to!', '$coerce_to', '$===', '$new', '$<<', '$[]', '$[]=', '$inspect', '$__send__', '$yield', '$enumerator_size', '$respond_to?', '$size', '$private', '$compare', '$<=>', '$dup', '$to_a', '$lambda', '$sort', '$call', '$first', '$zip']);
  return (function($base) {
    var self = $module($base, 'Enumerable');

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_16, TMP_17, TMP_18, TMP_19, TMP_20, TMP_22, TMP_23, TMP_24, TMP_25, TMP_26, TMP_27, TMP_28, TMP_29, TMP_30, TMP_31, TMP_32, TMP_33, TMP_35, TMP_37, TMP_41, TMP_42;

    Opal.defn(self, '$all?', TMP_1 = function() {
      var $a, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            result = false;
            return $breaker;
          }
        };
      }
      else {
        self.$each.$$p = function(obj) {
          if (arguments.length == 1 && (($a = obj) === nil || ($a.$$is_boolean && $a == false))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$any?', TMP_2 = function() {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = true;
            return $breaker;
          }
        };
      }
      else {
        self.$each.$$p = function(obj) {
          if (arguments.length != 1 || (($a = obj) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = true;
            return $breaker;
          }
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$chunk', TMP_3 = function(state) {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$collect', TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var value = Opal.yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        result.push(value);
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$collect_concat', TMP_5 = function() {
      var $a, $b, TMP_6, self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect_concat")
      };
      return ($a = ($b = self).$map, $a.$$p = (TMP_6 = function(item){var self = TMP_6.$$s || this, $a;
if (item == null) item = nil;
      return $a = Opal.yield1(block, item), $a === $breaker ? $a : $a}, TMP_6.$$s = self, TMP_6), $a).call($b).$flatten(1);
    });

    Opal.defn(self, '$count', TMP_7 = function(object) {
      var $a, self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      var result = 0;

      if (object != null) {
        block = function() {
          return $scope.get('Opal').$destructure(arguments)['$=='](object);
        };
      }
      else if (block === nil) {
        block = function() { return true; };
      }

      self.$each.$$p = function() {
        var value = Opal.yieldX(block, arguments);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result++;
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$cycle', TMP_8 = function(n) {
      var $a, self = this, $iter = TMP_8.$$p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_8.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        if ((($a = n <= 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
      };
      
      var result,
          all  = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        all.push(param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      if (all.length === 0) {
        return nil;
      }
    
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = Opal.yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        
        while (n > 1) {
          for (var i = 0, length = all.length; i < length; i++) {
            var value = Opal.yield1(block, all[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
    });

    Opal.defn(self, '$detect', TMP_9 = function(ifnone) {
      var $a, self = this, $iter = TMP_9.$$p, block = $iter || nil;

      TMP_9.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("detect", ifnone)
      };
      
      var result = undefined;

      self.$each.$$p = function() {
        var params = $scope.get('Opal').$destructure(arguments),
            value  = Opal.yield1(block, params);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result = params;
          return $breaker;
        }
      };

      self.$each();

      if (result === undefined && ifnone !== undefined) {
        if (typeof(ifnone) === 'function') {
          result = ifnone();
        }
        else {
          result = ifnone;
        }
      }

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$drop', function(number) {
      var $a, self = this;

      number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
      if ((($a = number < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
      
      var result  = [],
          current = 0;

      self.$each.$$p = function() {
        if (number <= current) {
          result.push($scope.get('Opal').$destructure(arguments));
        }

        current++;
      };

      self.$each()

      return result;
    
    });

    Opal.defn(self, '$drop_while', TMP_10 = function() {
      var $a, self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("drop_while")
      };
      
      var result   = [],
          dropping = true;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        if (dropping) {
          var value = Opal.yield1(block, param);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            dropping = false;
            result.push(param);
          }
        }
        else {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$each_cons', TMP_11 = function(n) {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$each_entry', TMP_12 = function() {
      var self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$each_slice', TMP_13 = function(n) {
      var $a, self = this, $iter = TMP_13.$$p, block = $iter || nil;

      TMP_13.$$p = null;
      n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
      if ((($a = n <= 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "invalid slice size")};
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_slice", n)
      };
      
      var result,
          slice = []

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        slice.push(param);

        if (slice.length === n) {
          if (Opal.yield1(block, slice) === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          slice = [];
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }

      // our "last" group, if smaller than n then won't have been yielded
      if (slice.length > 0) {
        if (Opal.yield1(block, slice) === $breaker) {
          return $breaker.$v;
        }
      }
    ;
      return nil;
    });

    Opal.defn(self, '$each_with_index', TMP_14 = function(args) {
      var $a, self = this, $iter = TMP_14.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_14.$$p = null;
      if ((block !== nil)) {
        } else {
        return ($a = self).$enum_for.apply($a, ["each_with_index"].concat(args))
      };
      
      var result,
          index = 0;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      };

      self.$each.apply(self, args);

      if (result !== undefined) {
        return result;
      }
    
      return self;
    });

    Opal.defn(self, '$each_with_object', TMP_15 = function(object) {
      var self = this, $iter = TMP_15.$$p, block = $iter || nil;

      TMP_15.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_with_object", object)
      };
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, object);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }
      };

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return object;
    });

    Opal.defn(self, '$entries', function(args) {
      var self = this;

      args = $slice.call(arguments, 0);
      
      var result = [];

      self.$each.$$p = function() {
        result.push($scope.get('Opal').$destructure(arguments));
      };

      self.$each.apply(self, args);

      return result;
    
    });

    Opal.defn(self, '$find', def.$detect);

    Opal.defn(self, '$find_all', TMP_16 = function() {
      var $a, self = this, $iter = TMP_16.$$p, block = $iter || nil;

      TMP_16.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("find_all")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$find_index', TMP_17 = function(object) {
      var $a, self = this, $iter = TMP_17.$$p, block = $iter || nil;

      TMP_17.$$p = null;
      if ((($a = object === undefined && block === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$enum_for("find_index")};
      
      var result = nil,
          index  = 0;

      if (object != null) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if ((param)['$=='](object)) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }
      else if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = index;
            return $breaker;
          }

          index += 1;
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$first', function(number) {
      var $a, self = this, result = nil;

      if ((($a = number === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        result = nil;
        
        self.$each.$$p = function() {
          result = $scope.get('Opal').$destructure(arguments);

          return $breaker;
        };

        self.$each();
      ;
        } else {
        result = [];
        number = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");
        if ((($a = number < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        if ((($a = number == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return []};
        
        var current = 0,
            number  = $scope.get('Opal').$coerce_to(number, $scope.get('Integer'), "to_int");

        self.$each.$$p = function() {
          result.push($scope.get('Opal').$destructure(arguments));

          if (number <= ++current) {
            return $breaker;
          }
        };

        self.$each();
      ;
      };
      return result;
    });

    Opal.defn(self, '$flat_map', def.$collect_concat);

    Opal.defn(self, '$grep', TMP_18 = function(pattern) {
      var $a, self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      
      var result = [];

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            value = Opal.yield1(block, param);

            if (value === $breaker) {
              result = $breaker.$v;
              return $breaker;
            }

            result.push(value);
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments),
              value = pattern['$==='](param);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result.push(param);
          }
        };
      }

      self.$each();

      return result;
    ;
    });

    Opal.defn(self, '$group_by', TMP_19 = function() {
      var $a, $b, $c, self = this, $iter = TMP_19.$$p, block = $iter || nil, hash = nil;

      TMP_19.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("group_by")
      };
      hash = $scope.get('Hash').$new();
      
      var result;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        (($a = value, $b = hash, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))))['$<<'](param);
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }
    
      return hash;
    });

    Opal.defn(self, '$include?', function(obj) {
      var self = this;

      
      var result = false;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments);

        if ((param)['$=='](obj)) {
          result = true;
          return $breaker;
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$inject', TMP_20 = function(object, sym) {
      var self = this, $iter = TMP_20.$$p, block = $iter || nil;

      TMP_20.$$p = null;
      
      var result = object;

      if (block !== nil && sym === undefined) {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          value = Opal.yieldX(block, [result, value]);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          result = value;
        };
      }
      else {
        if (sym === undefined) {
          if (!$scope.get('Symbol')['$==='](object)) {
            self.$raise($scope.get('TypeError'), "" + (object.$inspect()) + " is not a Symbol");
          }

          sym    = object;
          result = undefined;
        }

        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = value;
            return;
          }

          result = (result).$__send__(sym, value);
        };
      }

      self.$each();

      return result == undefined ? nil : result;
    ;
    });

    Opal.defn(self, '$lazy', function() {
      var $a, $b, TMP_21, self = this;

      return ($a = ($b = (($scope.get('Enumerator')).$$scope.get('Lazy'))).$new, $a.$$p = (TMP_21 = function(enum$, args){var self = TMP_21.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
      return ($a = enum$).$yield.apply($a, [].concat(args))}, TMP_21.$$s = self, TMP_21), $a).call($b, self, self.$enumerator_size());
    });

    Opal.defn(self, '$enumerator_size', function() {
      var $a, self = this;

      if ((($a = self['$respond_to?']("size")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$size()
        } else {
        return nil
      };
    });

    self.$private("enumerator_size");

    Opal.defn(self, '$map', def.$collect);

    Opal.defn(self, '$max', TMP_22 = function() {
      var self = this, $iter = TMP_22.$$p, block = $iter || nil;

      TMP_22.$$p = null;
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value > 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($scope.get('Opal').$compare(param, result) > 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$max_by', TMP_23 = function() {
      var self = this, $iter = TMP_23.$$p, block = $iter || nil;

      TMP_23.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("max_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) > 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$member?', def['$include?']);

    Opal.defn(self, '$min', TMP_24 = function() {
      var self = this, $iter = TMP_24.$$p, block = $iter || nil;

      TMP_24.$$p = null;
      
      var result;

      if (block !== nil) {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          var value = block(param, result);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if (value === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison failed");
          }

          if (value < 0) {
            result = param;
          }
        };
      }
      else {
        self.$each.$$p = function() {
          var param = $scope.get('Opal').$destructure(arguments);

          if (result === undefined) {
            result = param;
            return;
          }

          if ($scope.get('Opal').$compare(param, result) < 0) {
            result = param;
          }
        };
      }

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$min_by', TMP_25 = function() {
      var self = this, $iter = TMP_25.$$p, block = $iter || nil;

      TMP_25.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("min_by")
      };
      
      var result,
          by;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (result === undefined) {
          result = param;
          by     = value;
          return;
        }

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((value)['$<=>'](by) < 0) {
          result = param
          by     = value;
        }
      };

      self.$each();

      return result === undefined ? nil : result;
    
    });

    Opal.defn(self, '$minmax', TMP_26 = function() {
      var self = this, $iter = TMP_26.$$p, block = $iter || nil;

      TMP_26.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$minmax_by', TMP_27 = function() {
      var self = this, $iter = TMP_27.$$p, block = $iter || nil;

      TMP_27.$$p = null;
      return self.$raise($scope.get('NotImplementedError'));
    });

    Opal.defn(self, '$none?', TMP_28 = function() {
      var $a, self = this, $iter = TMP_28.$$p, block = $iter || nil;

      TMP_28.$$p = null;
      
      var result = true;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = false;
            return $breaker;
          }
        }
      }
      else {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            result = false;
            return $breaker;
          }
        };
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$one?', TMP_29 = function() {
      var $a, self = this, $iter = TMP_29.$$p, block = $iter || nil;

      TMP_29.$$p = null;
      
      var result = false;

      if (block !== nil) {
        self.$each.$$p = function() {
          var value = Opal.yieldX(block, arguments);

          if (value === $breaker) {
            result = $breaker.$v;
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }
      else {
        self.$each.$$p = function() {
          var value = $scope.get('Opal').$destructure(arguments);

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            if (result === true) {
              result = false;
              return $breaker;
            }

            result = true;
          }
        }
      }

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$partition', TMP_30 = function() {
      var $a, self = this, $iter = TMP_30.$$p, block = $iter || nil;

      TMP_30.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("partition")
      };
      
      var truthy = [], falsy = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
          truthy.push(param);
        }
        else {
          falsy.push(param);
        }
      };

      self.$each();

      return [truthy, falsy];
    
    });

    Opal.defn(self, '$reduce', def.$inject);

    Opal.defn(self, '$reject', TMP_31 = function() {
      var $a, self = this, $iter = TMP_31.$$p, block = $iter || nil;

      TMP_31.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
          result.push(param);
        }
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$reverse_each', TMP_32 = function() {
      var self = this, $iter = TMP_32.$$p, block = $iter || nil;

      TMP_32.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      
      var result = [];

      self.$each.$$p = function() {
        result.push(arguments);
      };

      self.$each();

      for (var i = result.length - 1; i >= 0; i--) {
        Opal.yieldX(block, result[i]);
      }

      return result;
    
    });

    Opal.defn(self, '$select', def.$find_all);

    Opal.defn(self, '$slice_before', TMP_33 = function(pattern) {
      var $a, $b, TMP_34, self = this, $iter = TMP_33.$$p, block = $iter || nil;

      TMP_33.$$p = null;
      if ((($a = pattern === undefined && block === nil || arguments.length > 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 1)")};
      return ($a = ($b = $scope.get('Enumerator')).$new, $a.$$p = (TMP_34 = function(e){var self = TMP_34.$$s || this, $a;
if (e == null) e = nil;
      
        var slice = [];

        if (block !== nil) {
          if (pattern === undefined) {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = Opal.yield1(block, param);

              if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
          else {
            self.$each.$$p = function() {
              var param = $scope.get('Opal').$destructure(arguments),
                  value = block(param, pattern.$dup());

              if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
                e['$<<'](slice);
                slice = [];
              }

              slice.push(param);
            };
          }
        }
        else {
          self.$each.$$p = function() {
            var param = $scope.get('Opal').$destructure(arguments),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true)) && slice.length > 0) {
              e['$<<'](slice);
              slice = [];
            }

            slice.push(param);
          };
        }

        self.$each();

        if (slice.length > 0) {
          e['$<<'](slice);
        }
      ;}, TMP_34.$$s = self, TMP_34), $a).call($b);
    });

    Opal.defn(self, '$sort', TMP_35 = function() {
      var $a, $b, TMP_36, self = this, $iter = TMP_35.$$p, block = $iter || nil, ary = nil;

      TMP_35.$$p = null;
      ary = self.$to_a();
      if ((block !== nil)) {
        } else {
        block = ($a = ($b = self).$lambda, $a.$$p = (TMP_36 = function(a, b){var self = TMP_36.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
        return a['$<=>'](b)}, TMP_36.$$s = self, TMP_36), $a).call($b)
      };
      return ary.sort(block);
    });

    Opal.defn(self, '$sort_by', TMP_37 = function() {
      var $a, $b, TMP_38, $c, $d, TMP_39, $e, $f, TMP_40, self = this, $iter = TMP_37.$$p, block = $iter || nil;

      TMP_37.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("sort_by")
      };
      return ($a = ($b = ($c = ($d = ($e = ($f = self).$map, $e.$$p = (TMP_40 = function(){var self = TMP_40.$$s || this;

      arg = $scope.get('Opal').$destructure(arguments);
        return [block.$call(arg), arg];}, TMP_40.$$s = self, TMP_40), $e).call($f)).$sort, $c.$$p = (TMP_39 = function(a, b){var self = TMP_39.$$s || this;
if (a == null) a = nil;if (b == null) b = nil;
      return a['$[]'](0)['$<=>'](b['$[]'](0))}, TMP_39.$$s = self, TMP_39), $c).call($d)).$map, $a.$$p = (TMP_38 = function(arg){var self = TMP_38.$$s || this;
if (arg == null) arg = nil;
      return arg[1];}, TMP_38.$$s = self, TMP_38), $a).call($b);
    });

    Opal.defn(self, '$take', function(num) {
      var self = this;

      return self.$first(num);
    });

    Opal.defn(self, '$take_while', TMP_41 = function() {
      var $a, self = this, $iter = TMP_41.$$p, block = $iter || nil;

      TMP_41.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("take_while")
      };
      
      var result = [];

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = Opal.yield1(block, param);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
          return $breaker;
        }

        result.push(param);
      };

      self.$each();

      return result;
    
    });

    Opal.defn(self, '$to_a', def.$entries);

    Opal.defn(self, '$zip', TMP_42 = function(others) {
      var $a, self = this, $iter = TMP_42.$$p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_42.$$p = null;
      return ($a = self.$to_a()).$zip.apply($a, [].concat(others));
    });
  })(self)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/enumerator"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$allocate', '$new', '$to_proc', '$coerce_to', '$nil?', '$empty?', '$+', '$class', '$__send__', '$===', '$call', '$enum_for', '$destructure', '$inspect', '$[]', '$raise', '$yield', '$each', '$enumerator_size', '$respond_to?', '$try_convert', '$<', '$for']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Enumerator(){};
    var self = $Enumerator = $klass($base, $super, 'Enumerator', $Enumerator);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.size = def.args = def.object = def.method = nil;
    self.$include($scope.get('Enumerable'));

    Opal.defs(self, '$for', TMP_1 = function(object, method, args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 2);
      if (method == null) {
        method = "each"
      }
      TMP_1.$$p = null;
      
      var obj = self.$allocate();

      obj.object = object;
      obj.size   = block;
      obj.method = method;
      obj.args   = args;

      return obj;
    ;
    });

    def.$initialize = TMP_2 = function() {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if (block !== false && block !== nil) {
        self.object = ($a = ($b = $scope.get('Generator')).$new, $a.$$p = block.$to_proc(), $a).call($b);
        self.method = "each";
        self.args = [];
        self.size = arguments[0] || nil;
        if ((($a = self.size) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.size = $scope.get('Opal').$coerce_to(self.size, $scope.get('Integer'), "to_int")
          } else {
          return nil
        };
        } else {
        self.object = arguments[0];
        self.method = arguments[1] || "each";
        self.args = $slice.call(arguments, 2);
        return self.size = nil;
      };
    };

    def.$each = TMP_3 = function(args) {
      var $a, $b, $c, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      if ((($a = ($b = block['$nil?'](), $b !== false && $b !== nil ?args['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      args = self.args['$+'](args);
      if ((($a = block['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self.$class()).$new.apply($a, [self.object, self.method].concat(args))};
      return ($b = ($c = self.object).$__send__, $b.$$p = block.$to_proc(), $b).apply($c, [self.method].concat(args));
    };

    def.$size = function() {
      var $a, self = this;

      if ((($a = $scope.get('Proc')['$==='](self.size)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self.size).$call.apply($a, [].concat(self.args))
        } else {
        return self.size
      };
    };

    def.$with_index = TMP_4 = function(offset) {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      if (offset == null) {
        offset = 0
      }
      TMP_4.$$p = null;
      if (offset !== false && offset !== nil) {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int")
        } else {
        offset = 0
      };
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("with_index", offset)
      };
      
      var result, index = 0;

      self.$each.$$p = function() {
        var param = $scope.get('Opal').$destructure(arguments),
            value = block(param, index);

        if (value === $breaker) {
          result = $breaker.$v;
          return $breaker;
        }

        index++;
      }

      self.$each();

      if (result !== undefined) {
        return result;
      }

      return nil;
    
    };

    Opal.defn(self, '$with_object', def.$each_with_object);

    def.$inspect = function() {
      var $a, self = this, result = nil;

      result = "#<" + (self.$class()) + ": " + (self.object.$inspect()) + ":" + (self.method);
      if ((($a = self.args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        result = result['$+']("(" + (self.args.$inspect()['$[]']($scope.get('Range').$new(1, -2))) + ")")
      };
      return result['$+'](">");
    };

    (function($base, $super) {
      function $Generator(){};
      var self = $Generator = $klass($base, $super, 'Generator', $Generator);

      var def = self.$$proto, $scope = self.$$scope, TMP_5, TMP_6;

      def.block = nil;
      self.$include($scope.get('Enumerable'));

      def.$initialize = TMP_5 = function() {
        var self = this, $iter = TMP_5.$$p, block = $iter || nil;

        TMP_5.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('LocalJumpError'), "no block given")
        };
        return self.block = block;
      };

      return (def.$each = TMP_6 = function(args) {
        var $a, $b, self = this, $iter = TMP_6.$$p, block = $iter || nil, yielder = nil;

        args = $slice.call(arguments, 0);
        TMP_6.$$p = null;
        yielder = ($a = ($b = $scope.get('Yielder')).$new, $a.$$p = block.$to_proc(), $a).call($b);
        
        try {
          args.unshift(yielder);

          if (Opal.yieldX(self.block, args) === $breaker) {
            return $breaker.$v;
          }
        }
        catch (e) {
          if (e === $breaker) {
            return $breaker.$v;
          }
          else {
            throw e;
          }
        }
      ;
        return self;
      }, nil) && 'each';
    })(self, null);

    (function($base, $super) {
      function $Yielder(){};
      var self = $Yielder = $klass($base, $super, 'Yielder', $Yielder);

      var def = self.$$proto, $scope = self.$$scope, TMP_7;

      def.block = nil;
      def.$initialize = TMP_7 = function() {
        var self = this, $iter = TMP_7.$$p, block = $iter || nil;

        TMP_7.$$p = null;
        return self.block = block;
      };

      def.$yield = function(values) {
        var self = this;

        values = $slice.call(arguments, 0);
        
        var value = Opal.yieldX(self.block, values);

        if (value === $breaker) {
          throw $breaker;
        }

        return value;
      ;
      };

      return (def['$<<'] = function(values) {
        var $a, self = this;

        values = $slice.call(arguments, 0);
        ($a = self).$yield.apply($a, [].concat(values));
        return self;
      }, nil) && '<<';
    })(self, null);

    return (function($base, $super) {
      function $Lazy(){};
      var self = $Lazy = $klass($base, $super, 'Lazy', $Lazy);

      var def = self.$$proto, $scope = self.$$scope, TMP_8, TMP_11, TMP_13, TMP_18, TMP_20, TMP_21, TMP_23, TMP_26, TMP_29;

      def.enumerator = nil;
      (function($base, $super) {
        function $StopLazyError(){};
        var self = $StopLazyError = $klass($base, $super, 'StopLazyError', $StopLazyError);

        var def = self.$$proto, $scope = self.$$scope;

        return nil;
      })(self, $scope.get('Exception'));

      def.$initialize = TMP_8 = function(object, size) {
        var TMP_9, self = this, $iter = TMP_8.$$p, block = $iter || nil;

        if (size == null) {
          size = nil
        }
        TMP_8.$$p = null;
        if ((block !== nil)) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy new without a block")
        };
        self.enumerator = object;
        return Opal.find_super_dispatcher(self, 'initialize', TMP_8, (TMP_9 = function(yielder, each_args){var self = TMP_9.$$s || this, $a, $b, TMP_10;
if (yielder == null) yielder = nil;each_args = $slice.call(arguments, 1);
        try {
          return ($a = ($b = object).$each, $a.$$p = (TMP_10 = function(args){var self = TMP_10.$$s || this;
args = $slice.call(arguments, 0);
            
              args.unshift(yielder);

              if (Opal.yieldX(block, args) === $breaker) {
                return $breaker;
              }
            ;}, TMP_10.$$s = self, TMP_10), $a).apply($b, [].concat(each_args))
          } catch ($err) {if (Opal.rescue($err, [$scope.get('Exception')])) {
            return nil
            }else { throw $err; }
          }}, TMP_9.$$s = self, TMP_9)).apply(self, [size]);
      };

      Opal.defn(self, '$force', def.$to_a);

      def.$lazy = function() {
        var self = this;

        return self;
      };

      def.$collect = TMP_11 = function() {
        var $a, $b, TMP_12, self = this, $iter = TMP_11.$$p, block = $iter || nil;

        TMP_11.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_12 = function(enum$, args){var self = TMP_12.$$s || this;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          enum$.$yield(value);
        }, TMP_12.$$s = self, TMP_12), $a).call($b, self, self.$enumerator_size());
      };

      def.$collect_concat = TMP_13 = function() {
        var $a, $b, TMP_14, self = this, $iter = TMP_13.$$p, block = $iter || nil;

        TMP_13.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy map without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_14 = function(enum$, args){var self = TMP_14.$$s || this, $a, $b, TMP_15, $c, TMP_16;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((value)['$respond_to?']("force") && (value)['$respond_to?']("each")) {
            ($a = ($b = (value)).$each, $a.$$p = (TMP_15 = function(v){var self = TMP_15.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_15.$$s = self, TMP_15), $a).call($b)
          }
          else {
            var array = $scope.get('Opal').$try_convert(value, $scope.get('Array'), "to_ary");

            if (array === nil) {
              enum$.$yield(value);
            }
            else {
              ($a = ($c = (value)).$each, $a.$$p = (TMP_16 = function(v){var self = TMP_16.$$s || this;
if (v == null) v = nil;
          return enum$.$yield(v)}, TMP_16.$$s = self, TMP_16), $a).call($c);
            }
          }
        ;}, TMP_14.$$s = self, TMP_14), $a).call($b, self, nil);
      };

      def.$drop = function(n) {
        var $a, $b, TMP_17, self = this, current_size = nil, set_size = nil, dropped = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if (n['$<'](0)) {
          self.$raise($scope.get('ArgumentError'), "attempt to drop negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        dropped = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_17 = function(enum$, args){var self = TMP_17.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (dropped['$<'](n)) {
            return dropped = dropped['$+'](1)
            } else {
            return ($a = enum$).$yield.apply($a, [].concat(args))
          }}, TMP_17.$$s = self, TMP_17), $a).call($b, self, set_size);
      };

      def.$drop_while = TMP_18 = function() {
        var $a, $b, TMP_19, self = this, $iter = TMP_18.$$p, block = $iter || nil, succeeding = nil;

        TMP_18.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy drop_while without a block")
        };
        succeeding = true;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_19 = function(enum$, args){var self = TMP_19.$$s || this, $a, $b;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (succeeding !== false && succeeding !== nil) {
            
            var value = Opal.yieldX(block, args);

            if (value === $breaker) {
              return $breaker;
            }

            if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
              succeeding = false;

              ($a = enum$).$yield.apply($a, [].concat(args));
            }
          
            } else {
            return ($b = enum$).$yield.apply($b, [].concat(args))
          }}, TMP_19.$$s = self, TMP_19), $a).call($b, self, nil);
      };

      def.$enum_for = TMP_20 = function(method, args) {
        var $a, $b, self = this, $iter = TMP_20.$$p, block = $iter || nil;

        args = $slice.call(arguments, 1);
        if (method == null) {
          method = "each"
        }
        TMP_20.$$p = null;
        return ($a = ($b = self.$class()).$for, $a.$$p = block.$to_proc(), $a).apply($b, [self, method].concat(args));
      };

      def.$find_all = TMP_21 = function() {
        var $a, $b, TMP_22, self = this, $iter = TMP_21.$$p, block = $iter || nil;

        TMP_21.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy select without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_22 = function(enum$, args){var self = TMP_22.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_22.$$s = self, TMP_22), $a).call($b, self, nil);
      };

      Opal.defn(self, '$flat_map', def.$collect_concat);

      def.$grep = TMP_23 = function(pattern) {
        var $a, $b, TMP_24, $c, TMP_25, self = this, $iter = TMP_23.$$p, block = $iter || nil;

        TMP_23.$$p = null;
        if (block !== false && block !== nil) {
          return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_24 = function(enum$, args){var self = TMP_24.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
              value = Opal.yield1(block, param);

              if (value === $breaker) {
                return $breaker;
              }

              enum$.$yield(Opal.yield1(block, param));
            }
          ;}, TMP_24.$$s = self, TMP_24), $a).call($b, self, nil)
          } else {
          return ($a = ($c = $scope.get('Lazy')).$new, $a.$$p = (TMP_25 = function(enum$, args){var self = TMP_25.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
          
            var param = $scope.get('Opal').$destructure(args),
                value = pattern['$==='](param);

            if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
              enum$.$yield(param);
            }
          ;}, TMP_25.$$s = self, TMP_25), $a).call($c, self, nil)
        };
      };

      Opal.defn(self, '$map', def.$collect);

      Opal.defn(self, '$select', def.$find_all);

      def.$reject = TMP_26 = function() {
        var $a, $b, TMP_27, self = this, $iter = TMP_26.$$p, block = $iter || nil;

        TMP_26.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy reject without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_27 = function(enum$, args){var self = TMP_27.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) === nil || ($a.$$is_boolean && $a == false))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
        ;}, TMP_27.$$s = self, TMP_27), $a).call($b, self, nil);
      };

      def.$take = function(n) {
        var $a, $b, TMP_28, self = this, current_size = nil, set_size = nil, taken = nil;

        n = $scope.get('Opal').$coerce_to(n, $scope.get('Integer'), "to_int");
        if (n['$<'](0)) {
          self.$raise($scope.get('ArgumentError'), "attempt to take negative size")};
        current_size = self.$enumerator_size();
        set_size = (function() {if ((($a = $scope.get('Integer')['$==='](current_size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          if (n['$<'](current_size)) {
            return n
            } else {
            return current_size
          }
          } else {
          return current_size
        }; return nil; })();
        taken = 0;
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_28 = function(enum$, args){var self = TMP_28.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        if (taken['$<'](n)) {
            ($a = enum$).$yield.apply($a, [].concat(args));
            return taken = taken['$+'](1);
            } else {
            return self.$raise($scope.get('StopLazyError'))
          }}, TMP_28.$$s = self, TMP_28), $a).call($b, self, set_size);
      };

      def.$take_while = TMP_29 = function() {
        var $a, $b, TMP_30, self = this, $iter = TMP_29.$$p, block = $iter || nil;

        TMP_29.$$p = null;
        if (block !== false && block !== nil) {
          } else {
          self.$raise($scope.get('ArgumentError'), "tried to call lazy take_while without a block")
        };
        return ($a = ($b = $scope.get('Lazy')).$new, $a.$$p = (TMP_30 = function(enum$, args){var self = TMP_30.$$s || this, $a;
if (enum$ == null) enum$ = nil;args = $slice.call(arguments, 1);
        
          var value = Opal.yieldX(block, args);

          if (value === $breaker) {
            return $breaker;
          }

          if ((($a = value) !== nil && (!$a.$$is_boolean || $a == true))) {
            ($a = enum$).$yield.apply($a, [].concat(args));
          }
          else {
            self.$raise($scope.get('StopLazyError'));
          }
        ;}, TMP_30.$$s = self, TMP_30), $a).call($b, self, nil);
      };

      Opal.defn(self, '$to_enum', def.$enum_for);

      return (def.$inspect = function() {
        var self = this;

        return "#<" + (self.$class()) + ": " + (self.enumerator.$inspect()) + ">";
      }, nil) && 'inspect';
    })(self, self);
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/array"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars, $range = Opal.range;

  Opal.add_stubs(['$require', '$include', '$new', '$class', '$raise', '$===', '$to_a', '$respond_to?', '$to_ary', '$coerce_to', '$coerce_to?', '$==', '$to_str', '$clone', '$hash', '$<=>', '$inspect', '$empty?', '$enum_for', '$nil?', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$replace', '$eql?', '$length', '$begin', '$end', '$exclude_end?', '$flatten', '$__id__', '$[]', '$to_s', '$join', '$delete_if', '$to_proc', '$each', '$reverse', '$!', '$map', '$rand', '$keep_if', '$shuffle!', '$>', '$<', '$sort', '$times', '$[]=', '$<<', '$at']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13, TMP_14, TMP_15, TMP_17, TMP_18, TMP_19, TMP_20, TMP_21, TMP_24;

    def.length = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_array = true;

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return objects;
    });

    def.$initialize = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.$class()).$new.apply($a, [].concat(args));
    };

    Opal.defs(self, '$new', TMP_1 = function(size, obj) {
      var $a, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      if (size == null) {
        size = nil
      }
      if (obj == null) {
        obj = nil
      }
      TMP_1.$$p = null;
      if ((($a = arguments.length > 2) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (arguments.length) + " for 0..2)")};
      if ((($a = arguments.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = arguments.length === 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](size)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return size.$to_a()
        } else if ((($a = size['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
          return size.$to_ary()}};
      size = $scope.get('Opal').$coerce_to(size, $scope.get('Integer'), "to_int");
      if ((($a = size < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      
      var result = [];

      if (block === nil) {
        for (var i = 0; i < size; i++) {
          result.push(obj);
        }
      }
      else {
        for (var i = 0, value; i < size; i++) {
          value = block(i);

          if (value === $breaker) {
            return $breaker.$v;
          }

          result[i] = value;
        }
      }

      return result;
    
    });

    Opal.defs(self, '$try_convert', function(obj) {
      var self = this;

      return $scope.get('Opal')['$coerce_to?'](obj, $scope.get('Array'), "to_ary");
    });

    def['$&'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          for (var j = 0, length2 = other.length; j < length2; j++) {
            var item2 = other[j];

            if (!seen[item2] && (item)['$=='](item2)) {
              seen[item] = true;
              result.push(item);
            }
          }
        }
      }

      return result;
    
    };

    def['$|'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          seen[item] = true;
          result.push(item);
        }
      }

      for (var i = 0, length = other.length; i < length; i++) {
        var item = other[i];

        if (!seen[item]) {
          seen[item] = true;
          result.push(item);
        }
      }
      return result;
    
    };

    def['$*'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.join(other.$to_str())};
      if ((($a = other['$respond_to?']("to_int")) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (other.$class()) + " into Integer")
      };
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      if ((($a = other < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative argument")};
      
      var result = [];

      for (var i = 0; i < other; i++) {
        result = result.concat(self);
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      return self.concat(other);
    };

    def['$-'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = other.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$clone()};
      
      var seen   = {},
          result = [];

      for (var i = 0, length = other.length; i < length; i++) {
        seen[other[i]] = true;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if (!seen[item]) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$<<'] = function(object) {
      var self = this;

      self.push(object);
      return self;
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
      } else if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_ary().$to_a()
        } else {
        return nil
      };
      
      if (self.$hash() === other.$hash()) {
        return 0;
      }

      if (self.length != other.length) {
        return (self.length > other.length) ? 1 : -1;
      }

      for (var i = 0, length = self.length; i < length; i++) {
        var tmp = (self[i])['$<=>'](other[i]);

        if (tmp !== 0) {
          return tmp;
        }
      }

      return 0;
    ;
    };

    def['$=='] = function(other) {
      var $a, self = this;

      if ((($a = self === other) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        if ((($a = other['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          return false
        };
        return other['$=='](self);
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a.$$is_array && b.$$is_array && (a === self)) {
          continue;
        }

        if (!(a)['$=='](b)) {
          return false;
        }
      }
    
      return true;
    };

    def['$[]'] = function(index, length) {
      var $a, self = this;

      if ((($a = $scope.get('Range')['$==='](index)) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        var size    = self.length,
            exclude = index.exclude,
            from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int"),
            to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            return nil;
          }
        }

        if (from > size) {
          return nil;
        }

        if (to < 0) {
          to += size;

          if (to < 0) {
            return [];
          }
        }

        if (!exclude) {
          to += 1;
        }

        return self.slice(from, to);
      ;
        } else {
        index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
        
        var size = self.length;

        if (index < 0) {
          index += size;

          if (index < 0) {
            return nil;
          }
        }

        if (length === undefined) {
          if (index >= size || index < 0) {
            return nil;
          }

          return self[index];
        }
        else {
          length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int");

          if (length < 0 || index > size || index < 0) {
            return nil;
          }

          return self.slice(index, index + length);
        }
      
      };
    };

    def['$[]='] = function(index, value, extra) {
      var $a, self = this, data = nil, length = nil;

      if ((($a = $scope.get('Range')['$==='](index)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = $scope.get('Array')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_a()
        } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
          data = value.$to_ary().$to_a()
          } else {
          data = [value]
        };
        
        var size    = self.length,
            exclude = index.exclude,
            from    = $scope.get('Opal').$coerce_to(index.begin, $scope.get('Integer'), "to_int"),
            to      = $scope.get('Opal').$coerce_to(index.end, $scope.get('Integer'), "to_int");

        if (from < 0) {
          from += size;

          if (from < 0) {
            self.$raise($scope.get('RangeError'), "" + (index.$inspect()) + " out of range");
          }
        }

        if (to < 0) {
          to += size;
        }

        if (!exclude) {
          to += 1;
        }

        if (from > size) {
          for (var i = size; i < from; i++) {
            self[i] = nil;
          }
        }

        if (to < 0) {
          self.splice.apply(self, [from, 0].concat(data));
        }
        else {
          self.splice.apply(self, [from, to - from].concat(data));
        }

        return value;
      ;
        } else {
        if ((($a = extra === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
          length = 1
          } else {
          length = value;
          value = extra;
          if ((($a = $scope.get('Array')['$==='](value)) !== nil && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_a()
          } else if ((($a = value['$respond_to?']("to_ary")) !== nil && (!$a.$$is_boolean || $a == true))) {
            data = value.$to_ary().$to_a()
            } else {
            data = [value]
          };
        };
        
        var size   = self.length,
            index  = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int"),
            length = $scope.get('Opal').$coerce_to(length, $scope.get('Integer'), "to_int"),
            old;

        if (index < 0) {
          old    = index;
          index += size;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "index " + (old) + " too small for array; minimum " + (-self.length));
          }
        }

        if (length < 0) {
          self.$raise($scope.get('IndexError'), "negative length (" + (length) + ")")
        }

        if (index > size) {
          for (var i = size; i < index; i++) {
            self[i] = nil;
          }
        }

        if (extra === undefined) {
          self[index] = value;
        }
        else {
          self.splice.apply(self, [index, length].concat(data));
        }

        return value;
      ;
      };
    };

    def.$assoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        if (item = self[i], item.length && (item[0])['$=='](object)) {
          return item;
        }
      }

      return nil;
    
    };

    def.$at = function(index) {
      var self = this;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");
      
      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self[index];
    
    };

    def.$cycle = TMP_2 = function(n) {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      if (n == null) {
        n = nil
      }
      TMP_2.$$p = null;
      if ((($a = ((($b = self['$empty?']()) !== false && $b !== nil) ? $b : n['$=='](0))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("cycle", n)
      };
      if ((($a = n['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        while (true) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = Opal.yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }
        }
      
        } else {
        n = $scope.get('Opal')['$coerce_to!'](n, $scope.get('Integer'), "to_int");
        
        if (n <= 0) {
          return self;
        }

        while (n > 0) {
          for (var i = 0, length = self.length; i < length; i++) {
            var value = Opal.yield1(block, self[i]);

            if (value === $breaker) {
              return $breaker.$v;
            }
          }

          n--;
        }
      
      };
      return self;
    };

    def.$clear = function() {
      var self = this;

      self.splice(0, self.length);
      return self;
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = [];
      copy.$initialize_dup(self);
      return copy;
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.$replace(other);
    };

    def.$collect = TMP_3 = function() {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect")
      };
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        result.push(value);
      }

      return result;
    
    };

    def['$collect!'] = TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("collect!")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value === $breaker) {
          return $breaker.$v;
        }

        self[i] = value;
      }
    
      return self;
    };

    def.$compact = function() {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length, item; i < length; i++) {
        if ((item = self[i]) !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$compact!'] = function() {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = self.length; i < length; i++) {
        if (self[i] === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$concat = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      for (var i = 0, length = other.length; i < length; i++) {
        self.push(other[i]);
      }
    
      return self;
    };

    def.$delete = function(object) {
      var self = this;

      
      var original = self.length;

      for (var i = 0, length = original; i < length; i++) {
        if ((self[i])['$=='](object)) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : object;
    
    };

    def.$delete_at = function(index) {
      var self = this;

      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      var result = self[index];

      self.splice(index, 1);

      return result;
    ;
    };

    def.$delete_if = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$drop = function(number) {
      var self = this;

      
      if (number < 0) {
        self.$raise($scope.get('ArgumentError'))
      }

      return self.slice(number);
    ;
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, self[i]);

        if (value == $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$each_index = TMP_7 = function() {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_index")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var value = Opal.yield1(block, i);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$eql?'] = function(other) {
      var $a, self = this;

      if ((($a = self === other) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      other = other.$to_a();
      if ((($a = self.length === other.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        var a = self[i],
            b = other[i];

        if (a.$$is_array && b.$$is_array && (a === self)) {
          continue;
        }

        if (!(a)['$eql?'](b)) {
          return false;
        }
      }
    
      return true;
    };

    def.$fetch = TMP_8 = function(index, defaults) {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      
      var original = index;

      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (index < 0) {
        index += self.length;
      }

      if (index >= 0 && index < self.length) {
        return self[index];
      }

      if (block !== nil) {
        return block(original);
      }

      if (defaults != null) {
        return defaults;
      }

      if (self.length === 0) {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: 0...0")
      }
      else {
        self.$raise($scope.get('IndexError'), "index " + (original) + " outside of array bounds: -" + (self.length) + "..." + (self.length));
      }
    ;
    };

    def.$fill = TMP_9 = function(args) {
      var $a, self = this, $iter = TMP_9.$$p, block = $iter || nil, one = nil, two = nil, obj = nil, left = nil, right = nil;

      args = $slice.call(arguments, 0);
      TMP_9.$$p = null;
      if (block !== false && block !== nil) {
        if ((($a = args.length > 2) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 0..2)")};
        $a = Opal.to_ary(args), one = ($a[0] == null ? nil : $a[0]), two = ($a[1] == null ? nil : $a[1]);
        } else {
        if ((($a = args.length == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (0 for 1..3)")
        } else if ((($a = args.length > 3) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "wrong number of arguments (" + (args.$length()) + " for 1..3)")};
        $a = Opal.to_ary(args), obj = ($a[0] == null ? nil : $a[0]), one = ($a[1] == null ? nil : $a[1]), two = ($a[2] == null ? nil : $a[2]);
      };
      if ((($a = $scope.get('Range')['$==='](one)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (two !== false && two !== nil) {
          self.$raise($scope.get('TypeError'), "length invalid with range")};
        left = $scope.get('Opal').$coerce_to(one.$begin(), $scope.get('Integer'), "to_int");
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('RangeError'), "" + (one.$inspect()) + " out of range")};
        right = $scope.get('Opal').$coerce_to(one.$end(), $scope.get('Integer'), "to_int");
        if ((($a = right < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          right += self.length;};
        if ((($a = one['$exclude_end?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          right += 1;
        };
        if ((($a = right <= left) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self};
      } else if (one !== false && one !== nil) {
        left = $scope.get('Opal').$coerce_to(one, $scope.get('Integer'), "to_int");
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left += self.length;};
        if ((($a = left < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          left = 0};
        if (two !== false && two !== nil) {
          right = $scope.get('Opal').$coerce_to(two, $scope.get('Integer'), "to_int");
          if ((($a = right == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
            return self};
          right += left;
          } else {
          right = self.length
        };
        } else {
        left = 0;
        right = self.length;
      };
      if ((($a = left > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        for (var i = self.length; i < right; i++) {
          self[i] = nil;
        }
      ;};
      if ((($a = right > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.length = right};
      if (block !== false && block !== nil) {
        
        for (var length = self.length; left < right; left++) {
          var value = block(left);

          if (value === $breaker) {
            return $breaker.$v;
          }

          self[left] = value;
        }
      ;
        } else {
        
        for (var length = self.length; left < right; left++) {
          self[left] = obj;
        }
      ;
      };
      return self;
    };

    def.$first = function(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[0];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      return self.slice(0, count);
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ($scope.get('Opal')['$respond_to?'](item, "to_ary")) {
          item = (item).$to_ary();

          if (level == null) {
            result.push.apply(result, (item).$flatten().$to_a());
          }
          else if (level == 0) {
            result.push(item);
          }
          else {
            result.push.apply(result, (item).$flatten(level - 1).$to_a());
          }
        }
        else {
          result.push(item);
        }
      }

      return result;
    ;
    };

    def['$flatten!'] = function(level) {
      var self = this;

      
      var flattened = self.$flatten(level);

      if (self.length == flattened.length) {
        for (var i = 0, length = self.length; i < length; i++) {
          if (self[i] !== flattened[i]) {
            break;
          }
        }

        if (i == length) {
          return nil;
        }
      }

      self.$replace(flattened);
    ;
      return self;
    };

    def.$hash = function() {
      var self = this;

      
      var hash = ['A'], item, item_hash;
      for (var i = 0, length = self.length; i < length; i++) {
        item = self[i];
        // Guard against recursion
        item_hash = self === item ? 'self' : item.$hash();
        hash.push(item_hash);
      }
      return hash.join(',');
    
    };

    def['$include?'] = function(member) {
      var self = this;

      
      for (var i = 0, length = self.length; i < length; i++) {
        if ((self[i])['$=='](member)) {
          return true;
        }
      }

      return false;
    
    };

    def.$index = TMP_10 = function(object) {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      
      if (object != null) {
        for (var i = 0, length = self.length; i < length; i++) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = 0, length = self.length, value; i < length; i++) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else {
        return self.$enum_for("index");
      }

      return nil;
    
    };

    def.$insert = function(index, objects) {
      var self = this;

      objects = $slice.call(arguments, 1);
      
      index = $scope.get('Opal').$coerce_to(index, $scope.get('Integer'), "to_int");

      if (objects.length > 0) {
        if (index < 0) {
          index += self.length + 1;

          if (index < 0) {
            self.$raise($scope.get('IndexError'), "" + (index) + " is out of bounds");
          }
        }
        if (index > self.length) {
          for (var i = self.length; i < index; i++) {
            self.push(nil);
          }
        }

        self.splice.apply(self, [index, 0].concat(objects));
      }
    ;
      return self;
    };

    def.$inspect = function() {
      var self = this;

      
      var result = [],
          id     = self.$__id__();

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self['$[]'](i);

        if ((item).$__id__() === id) {
          result.push('[...]');
        }
        else {
          result.push((item).$inspect());
        }
      }

      return '[' + result.join(', ') + ']';
    ;
    };

    def.$join = function(sep) {
      var $a, self = this;
      if ($gvars[","] == null) $gvars[","] = nil;

      if (sep == null) {
        sep = nil
      }
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ""};
      if ((($a = sep === nil) !== nil && (!$a.$$is_boolean || $a == true))) {
        sep = $gvars[","]};
      
      var result = [];

      for (var i = 0, length = self.length; i < length; i++) {
        var item = self[i];

        if ($scope.get('Opal')['$respond_to?'](item, "to_str")) {
          var tmp = (item).$to_str();

          if (tmp !== nil) {
            result.push((tmp).$to_s());

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_ary")) {
          var tmp = (item).$to_ary();

          if (tmp !== nil) {
            result.push((tmp).$join(sep));

            continue;
          }
        }

        if ($scope.get('Opal')['$respond_to?'](item, "to_s")) {
          var tmp = (item).$to_s();

          if (tmp !== nil) {
            result.push(tmp);

            continue;
          }
        }

        self.$raise($scope.get('NoMethodError'), "" + ($scope.get('Opal').$inspect(item)) + " doesn't respond to #to_str, #to_ary or #to_s");
      }

      if (sep === nil) {
        return result.join('');
      }
      else {
        return result.join($scope.get('Opal')['$coerce_to!'](sep, $scope.get('String'), "to_str").$to_s());
      }
    ;
    };

    def.$keep_if = TMP_11 = function() {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          self.splice(i, 1);

          length--;
          i--;
        }
      }
    
      return self;
    };

    def.$last = function(count) {
      var self = this;

      
      if (count == null) {
        return self.length === 0 ? nil : self[self.length - 1];
      }

      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");

      if (count < 0) {
        self.$raise($scope.get('ArgumentError'), "negative array size");
      }

      if (count > self.length) {
        count = self.length;
      }

      return self.slice(self.length - count, self.length);
    
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    Opal.defn(self, '$map', def.$collect);

    Opal.defn(self, '$map!', def['$collect!']);

    def.$pop = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.pop();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if ((($a = count > self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.splice(0, self.length);
        } else {
        return self.splice(self.length - count, self.length);
      };
    };

    def.$push = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = 0, length = objects.length; i < length; i++) {
        self.push(objects[i]);
      }
    
      return self;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      for (var i = 0, length = self.length, item; i < length; i++) {
        item = self[i];

        if (item.length && item[1] !== undefined) {
          if ((item[1])['$=='](object)) {
            return item;
          }
        }
      }

      return nil;
    
    };

    def.$reject = TMP_12 = function() {
      var self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject")
      };
      
      var result = [];

      for (var i = 0, length = self.length, value; i < length; i++) {
        if ((value = block(self[i])) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          result.push(self[i]);
        }
      }
      return result;
    
    };

    def['$reject!'] = TMP_13 = function() {
      var $a, $b, self = this, $iter = TMP_13.$$p, block = $iter || nil, original = nil;

      TMP_13.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reject!")
      };
      original = self.$length();
      ($a = ($b = self).$delete_if, $a.$$p = block.$to_proc(), $a).call($b);
      if (self.$length()['$=='](original)) {
        return nil
        } else {
        return self
      };
    };

    def.$replace = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_a()
        } else {
        other = $scope.get('Opal').$coerce_to(other, $scope.get('Array'), "to_ary").$to_a()
      };
      
      self.splice(0, self.length);
      self.push.apply(self, other);
    
      return self;
    };

    def.$reverse = function() {
      var self = this;

      return self.slice(0).reverse();
    };

    def['$reverse!'] = function() {
      var self = this;

      return self.reverse();
    };

    def.$reverse_each = TMP_14 = function() {
      var $a, $b, self = this, $iter = TMP_14.$$p, block = $iter || nil;

      TMP_14.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("reverse_each")
      };
      ($a = ($b = self.$reverse()).$each, $a.$$p = block.$to_proc(), $a).call($b);
      return self;
    };

    def.$rindex = TMP_15 = function(object) {
      var self = this, $iter = TMP_15.$$p, block = $iter || nil;

      TMP_15.$$p = null;
      
      if (object != null) {
        for (var i = self.length - 1; i >= 0; i--) {
          if ((self[i])['$=='](object)) {
            return i;
          }
        }
      }
      else if (block !== nil) {
        for (var i = self.length - 1, value; i >= 0; i--) {
          if ((value = block(self[i])) === $breaker) {
            return $breaker.$v;
          }

          if (value !== false && value !== nil) {
            return i;
          }
        }
      }
      else if (object == null) {
        return self.$enum_for("rindex");
      }

      return nil;
    
    };

    def.$sample = function(n) {
      var $a, $b, TMP_16, self = this;

      if (n == null) {
        n = nil
      }
      if ((($a = ($b = n['$!'](), $b !== false && $b !== nil ?self['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil};
      if ((($a = (($b = n !== false && n !== nil) ? self['$empty?']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      if (n !== false && n !== nil) {
        return ($a = ($b = ($range(1, n, false))).$map, $a.$$p = (TMP_16 = function(){var self = TMP_16.$$s || this;

        return self['$[]'](self.$rand(self.$length()))}, TMP_16.$$s = self, TMP_16), $a).call($b)
        } else {
        return self['$[]'](self.$rand(self.$length()))
      };
    };

    def.$select = TMP_17 = function() {
      var self = this, $iter = TMP_17.$$p, block = $iter || nil;

      TMP_17.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select")
      };
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = Opal.yield1(block, item)) === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          result.push(item);
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_18 = function() {
      var $a, $b, self = this, $iter = TMP_18.$$p, block = $iter || nil;

      TMP_18.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("select!")
      };
      
      var original = self.length;
      ($a = ($b = self).$keep_if, $a.$$p = block.$to_proc(), $a).call($b);
      return self.length === original ? nil : self;
    
    };

    def.$shift = function(count) {
      var $a, self = this;

      if ((($a = count === undefined) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return self.shift();};
      count = $scope.get('Opal').$coerce_to(count, $scope.get('Integer'), "to_int");
      if ((($a = count < 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "negative array size")};
      if ((($a = self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      return self.splice(0, count);
    };

    Opal.defn(self, '$size', def.$length);

    def.$shuffle = function() {
      var self = this;

      return self.$clone()['$shuffle!']();
    };

    def['$shuffle!'] = function() {
      var self = this;

      
      for (var i = self.length - 1; i > 0; i--) {
        var tmp = self[i],
            j   = Math.floor(Math.random() * (i + 1));

        self[i] = self[j];
        self[j] = tmp;
      }
    
      return self;
    };

    Opal.defn(self, '$slice', def['$[]']);

    def['$slice!'] = function(index, length) {
      var self = this;

      
      if (index < 0) {
        index += self.length;
      }

      if (length != null) {
        return self.splice(index, length);
      }

      if (index < 0 || index >= self.length) {
        return nil;
      }

      return self.splice(index, 1)[0];
    
    };

    def.$sort = TMP_19 = function() {
      var $a, self = this, $iter = TMP_19.$$p, block = $iter || nil;

      TMP_19.$$p = null;
      if ((($a = self.length > 1) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return self
      };
      
      if (!(block !== nil)) {
        block = function(a, b) {
          return (a)['$<=>'](b);
        };
      }

      try {
        return self.slice().sort(function(x, y) {
          var ret = block(x, y);

          if (ret === $breaker) {
            throw $breaker;
          }
          else if (ret === nil) {
            self.$raise($scope.get('ArgumentError'), "comparison of " + ((x).$inspect()) + " with " + ((y).$inspect()) + " failed");
          }

          return (ret)['$>'](0) ? 1 : ((ret)['$<'](0) ? -1 : 0);
        });
      }
      catch (e) {
        if (e === $breaker) {
          return $breaker.$v;
        }
        else {
          throw e;
        }
      }
    ;
    };

    def['$sort!'] = TMP_20 = function() {
      var $a, $b, self = this, $iter = TMP_20.$$p, block = $iter || nil;

      TMP_20.$$p = null;
      
      var result;

      if ((block !== nil)) {
        result = ($a = ($b = (self.slice())).$sort, $a.$$p = block.$to_proc(), $a).call($b);
      }
      else {
        result = (self.slice()).$sort();
      }

      self.length = 0;
      for(var i = 0, length = result.length; i < length; i++) {
        self.push(result[i]);
      }

      return self;
    ;
    };

    def.$take = function(count) {
      var self = this;

      
      if (count < 0) {
        self.$raise($scope.get('ArgumentError'));
      }

      return self.slice(0, count);
    ;
    };

    def.$take_while = TMP_21 = function() {
      var self = this, $iter = TMP_21.$$p, block = $iter || nil;

      TMP_21.$$p = null;
      
      var result = [];

      for (var i = 0, length = self.length, item, value; i < length; i++) {
        item = self[i];

        if ((value = block(item)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          return result;
        }

        result.push(item);
      }

      return result;
    
    };

    def.$to_a = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$to_ary', def.$to_a);

    Opal.defn(self, '$to_s', def.$inspect);

    def.$transpose = function() {
      var $a, $b, TMP_22, self = this, result = nil, max = nil;

      if ((($a = self['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return []};
      result = [];
      max = nil;
      ($a = ($b = self).$each, $a.$$p = (TMP_22 = function(row){var self = TMP_22.$$s || this, $a, $b, TMP_23;
if (row == null) row = nil;
      if ((($a = $scope.get('Array')['$==='](row)) !== nil && (!$a.$$is_boolean || $a == true))) {
          row = row.$to_a()
          } else {
          row = $scope.get('Opal').$coerce_to(row, $scope.get('Array'), "to_ary").$to_a()
        };
        ((($a = max) !== false && $a !== nil) ? $a : max = row.length);
        if ((($a = (row.length)['$=='](max)['$!']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('IndexError'), "element size differs (" + (row.length) + " should be " + (max))};
        return ($a = ($b = (row.length)).$times, $a.$$p = (TMP_23 = function(i){var self = TMP_23.$$s || this, $a, $b, $c, entry = nil;
if (i == null) i = nil;
        entry = (($a = i, $b = result, ((($c = $b['$[]']($a)) !== false && $c !== nil) ? $c : $b['$[]=']($a, []))));
          return entry['$<<'](row.$at(i));}, TMP_23.$$s = self, TMP_23), $a).call($b);}, TMP_22.$$s = self, TMP_22), $a).call($b);
      return result;
    };

    def.$uniq = function() {
      var self = this;

      
      var result = [],
          seen   = {};

      for (var i = 0, length = self.length, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;

          result.push(item);
        }
      }

      return result;
    
    };

    def['$uniq!'] = function() {
      var self = this;

      
      var original = self.length,
          seen     = {};

      for (var i = 0, length = original, item, hash; i < length; i++) {
        item = self[i];
        hash = item;

        if (!seen[hash]) {
          seen[hash] = true;
        }
        else {
          self.splice(i, 1);

          length--;
          i--;
        }
      }

      return self.length === original ? nil : self;
    
    };

    def.$unshift = function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      
      for (var i = objects.length - 1; i >= 0; i--) {
        self.unshift(objects[i]);
      }
    
      return self;
    };

    return (def.$zip = TMP_24 = function(others) {
      var self = this, $iter = TMP_24.$$p, block = $iter || nil;

      others = $slice.call(arguments, 0);
      TMP_24.$$p = null;
      
      var result = [], size = self.length, part, o;

      for (var i = 0; i < size; i++) {
        part = [self[i]];

        for (var j = 0, jj = others.length; j < jj; j++) {
          o = others[j][i];

          if (o == null) {
            o = nil;
          }

          part[j + 1] = o;
        }

        result[i] = part;
      }

      if (block !== nil) {
        for (var i = 0; i < size; i++) {
          block(result[i]);
        }

        return nil;
      }

      return result;
    
    }, nil) && 'zip';
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/array/inheritance"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$clone', '$respond_to?', '$==', '$eql?', '$inspect', '$*', '$class', '$slice', '$uniq', '$flatten']);
  (function($base, $super) {
    function $Array(){};
    var self = $Array = $klass($base, $super, 'Array', $Array);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$inherited', function(klass) {
      var self = this, replace = nil;

      replace = $scope.get('Class').$new((($scope.get('Array')).$$scope.get('Wrapper')));
      
      klass.$$proto         = replace.$$proto;
      klass.$$proto.$$class = klass;
      klass.$$alloc         = replace.$$alloc;
      klass.$$parent        = (($scope.get('Array')).$$scope.get('Wrapper'));

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
      klass["$[]"]    = replace["$[]"];
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5;

    def.literal = nil;
    Opal.defs(self, '$allocate', TMP_1 = function(array) {
      var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, obj = nil;

      if (array == null) {
        array = []
      }
      TMP_1.$$p = null;
      obj = Opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = array;
      return obj;
    });

    Opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      return self.literal = ($a = ($b = $scope.get('Array')).$new, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
    };

    def.$method_missing = TMP_4 = function(args) {
      var $a, $b, self = this, $iter = TMP_4.$$p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_4.$$p = null;
      result = ($a = ($b = self.literal).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result === self.literal) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_5 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_5.$$p, $yield = $iter || nil;

      TMP_5.$$p = null;
      return ((($a = Opal.find_super_dispatcher(self, 'respond_to?', TMP_5, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    def['$eql?'] = function(other) {
      var self = this;

      return self.literal['$eql?'](other);
    };

    def.$to_a = function() {
      var self = this;

      return self.literal;
    };

    def.$to_ary = function() {
      var self = this;

      return self;
    };

    def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    };

    def['$*'] = function(other) {
      var self = this;

      
      var result = self.literal['$*'](other);

      if (result.$$is_array) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var result = self.literal.$slice(index, length);

      if (result.$$is_array && (index.$$is_range || length !== undefined)) {
        return self.$class().$allocate(result)
      }
      else {
        return result;
      }
    ;
    };

    Opal.defn(self, '$slice', def['$[]']);

    def.$uniq = function() {
      var self = this;

      return self.$class().$allocate(self.literal.$uniq());
    };

    return (def.$flatten = function(level) {
      var self = this;

      return self.$class().$allocate(self.literal.$flatten(level));
    }, nil) && 'flatten';
  })($scope.get('Array'), null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/hash"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$!', '$==', '$call', '$coerce_to!', '$lambda?', '$abs', '$arity', '$raise', '$enum_for', '$flatten', '$eql?', '$===', '$clone', '$merge!', '$to_proc', '$alias_method']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Hash(){};
    var self = $Hash = $klass($base, $super, 'Hash', $Hash);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7, TMP_8, TMP_9, TMP_10, TMP_11, TMP_12, TMP_13;

    def.proc = def.none = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_hash = true;

    Opal.defs(self, '$[]', function(objs) {
      var self = this;

      objs = $slice.call(arguments, 0);
      return Opal.hash.apply(null, objs);
    });

    Opal.defs(self, '$allocate', function() {
      var self = this;

      
      var hash = new self.$$alloc;

      hash.map  = {};
      hash.smap = {};
      hash.keys = [];
      hash.none = nil;
      hash.proc = nil;

      return hash;
    
    });

    def.$initialize = TMP_1 = function(defaults) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      
      self.none = (defaults === undefined ? nil : defaults);
      self.proc = block;
    
      return self;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (self === other) {
        return true;
      }

      if (!other.keys || !other.smap || !other.map) {
        return false;
      }

      if (self.keys.length !== other.keys.length) {
        return false;
      }

      var _map  = self.map,
          smap  = self.smap,
          _map2 = other.map,
          smap2 = other.smap,
          map, map2, key, khash, value, value2;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        key = self.keys[i];

        if (key.$$is_string) {
          khash = key;
          map   = smap;
          map2  = smap2;
        } else {
          khash = key.$hash();
          map   = _map;
          map2  = _map2;
        }

        value  = map[khash];
        if (value === undefined) console.log('==', key, self);
        value2 = map2[khash];

        if (value2 === undefined || ((value)['$=='](value2))['$!']()) {
          return false;
        }
      }

      return true;
    
    };

    def['$[]'] = function(key) {
      var self = this;

      
      var map, khash;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      if (map === undefined) { console.log(self, '[] --> key:', key, khash, map) }


      if (Opal.hasOwnProperty.call(map, khash)) {
        return map[khash];
      }

      var proc = self.proc;

      if (proc !== nil) {
        return (proc).$call(self, key);
      }

      return self.none;
    
    };

    def['$[]='] = function(key, value) {
      var self = this;

      
      var map, khash, value;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      if (!Opal.hasOwnProperty.call(map, khash)) {
        self.keys.push(key);
      }

      map[khash] = value;

      return value;
    
    };

    def.$assoc = function(object) {
      var self = this;

      
      var keys = self.keys,
          map, key, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if ((key)['$=='](object)) {
          if (key.$$is_string) {
            map = self.smap;
            khash = key;
          } else {
            map = self.map;
            khash = key.$hash();
          }

          return [key, map[khash]];
        }
      }

      return nil;
    
    };

    def.$clear = function() {
      var self = this;

      
      self.map = {};
      self.smap = {};
      self.keys = [];
      return self;
    
    };

    def.$clone = function() {
      var self = this;

      
      var _map  = {},
          smap  = {},
          _map2 = self.map,
          smap2 = self.smap,
          keys  = [],
          map, map2, key, khash, value;

      for (var i = 0, length = self.keys.length; i < length; i++) {
        key   = self.keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        value = map2[khash];

        keys.push(key);
        map[khash] = value;
      }

      var clone = new self.$$class.$$alloc();

      clone.map  = _map;
      clone.smap = smap;
      clone.keys = keys;
      clone.none = self.none;
      clone.proc = self.proc;

      return clone;
    
    };

    def.$default = function(val) {
      var self = this;

      
      if (val !== undefined && self.proc !== nil) {
        return self.proc.$call(self, val);
      }
      return self.none;
    ;
    };

    def['$default='] = function(object) {
      var self = this;

      
      self.proc = nil;
      return (self.none = object);
    
    };

    def.$default_proc = function() {
      var self = this;

      return self.proc;
    };

    def['$default_proc='] = function(proc) {
      var self = this;

      
      if (proc !== nil) {
        proc = $scope.get('Opal')['$coerce_to!'](proc, $scope.get('Proc'), "to_proc");

        if (proc['$lambda?']() && proc.$arity().$abs() != 2) {
          self.$raise($scope.get('TypeError'), "default_proc takes two arguments");
        }
      }
      self.none = nil;
      return (self.proc = proc);
    ;
    };

    def.$delete = TMP_2 = function(key) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      
      var result, map, khash;

      if (key.$$is_string) {
        map = self.smap;
        khash = key;
      } else {
        map = self.map;
        khash = key.$hash();
      }

      result = map[khash];

      if (result != null) {
        delete map[khash];
        self.keys.$delete(key);

        return result;
      }

      if (block !== nil) {
        return block.$call(key);
      }
      return nil;
    
    };

    def.$delete_if = TMP_3 = function() {
      var self = this, $iter = TMP_3.$$p, block = $iter || nil;

      TMP_3.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("delete_if")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, value, obj, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }
        obj = map[khash];
        value = block(key, obj);

        if (value === $breaker) {
          return $breaker.$v;
        }

        if (value !== false && value !== nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$each = TMP_4 = function() {
      var self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        value = Opal.yield1(block, [key, map[khash]]);

        if (value === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def.$each_key = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_key")
      };
      
      var keys = self.keys, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (block(key) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$each_pair', def.$each);

    def.$each_value = TMP_6 = function() {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("each_value")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        if (block(map[khash]) === $breaker) {
          return $breaker.$v;
        }
      }

      return self;
    
    };

    def['$empty?'] = function() {
      var self = this;

      return self.keys.length === 0;
    };

    Opal.defn(self, '$eql?', def['$==']);

    def.$fetch = TMP_7 = function(key, defaults) {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      var map, khash, value;

      if (key.$$is_string) {
        khash = key;
        map = self.smap;
      } else {
        khash = key.$hash();
        map = self.map;
      }

      value = map[khash];

      if (value != null) {
        return value;
      }

      if (block !== nil) {
        var value;

        if ((value = block(key)) === $breaker) {
          return $breaker.$v;
        }

        return value;
      }

      if (defaults != null) {
        return defaults;
      }

      self.$raise($scope.get('KeyError'), "key not found");
    
    };

    def.$flatten = function(level) {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = [],
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        result.push(key);

        if (value.$$is_array) {
          if (level == null || level === 1) {
            result.push(value);
          }
          else {
            result = result.concat((value).$flatten(level - 1));
          }
        }
        else {
          result.push(value);
        }
      }

      return result;
    
    };

    def['$has_key?'] = function(key) {
      var self = this;

      
      var keys = self.keys,
          map, khash;

      if (key.$$is_string) {
        khash = key;
        map = self.smap;
      } else {
        khash = key.$hash();
        map = self.map;
      }

      if (Opal.hasOwnProperty.call(map, khash)) {
        for (var i = 0, length = keys.length; i < length; i++) {
          if (!(key['$eql?'](keys[i]))['$!']()) {
            return true;
          }
        }
      }

      return false;
    
    };

    def['$has_value?'] = function(value) {
      var self = this;

      
      for (var khash in self.map) {
        if ((self.map[khash])['$=='](value)) {
          return true;
        }
      }

      return false;
    ;
    };

    var hash_ids = null;

    def.$hash = function() {
      var self = this;

      
      var top = (hash_ids === null);
      try {
        var key, value,
            hash = ['Hash'],
            keys = self.keys,
            id = self.$object_id(),
            counter = 0;

        if (top) {
          hash_ids = {}
        }

        if (hash_ids.hasOwnProperty(id)) {
          return 'self';
        }

        hash_ids[id] = true;

        for (var i = 0, length = keys.length; i < length; i++) {
          key   = keys[i];
          value = key.$$is_string ? self.smap[key] : self.map[key.$hash()];
          key   = key.$hash();
          value = (typeof(value) === 'undefined') ? '' : value.$hash();
          hash.push([key,value]);
        }

        return hash.sort().join();
      } finally {
        if (top) {
          hash_ids = null;
        }
      }
    
    };

    Opal.defn(self, '$include?', def['$has_key?']);

    def.$index = function(object) {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, khash, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        if ((map[khash])['$=='](object)) {
          return key;
        }
      }

      return nil;
    
    };

    def.$indexes = function(keys) {
      var self = this;

      keys = $slice.call(arguments, 0);
      
      var result = [],
          _map = self.map,
          smap = self.smap,
          map, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        if (value != null) {
          result.push(value);
        }
        else {
          result.push(self.none);
        }
      }

      return result;
    
    };

    Opal.defn(self, '$indices', def.$indexes);

    var inspect_ids = null;

    def.$inspect = function() {
      var self = this;

      
      var top = (inspect_ids === null);
      try {

        var key, value,
            inspect = [],
            keys = self.keys
            id = self.$object_id(),
            counter = 0;

        if (top) {
          inspect_ids = {}
        }

        if (inspect_ids.hasOwnProperty(id)) {
          return '{...}';
        }

        inspect_ids[id] = true;

        for (var i = 0, length = keys.length; i < length; i++) {
          key   = keys[i];
          value = key.$$is_string ? self.smap[key] : self.map[key.$hash()];
          key   = key.$inspect();
          value = value.$inspect();
          inspect.push(key + '=>' + value);
        }

        return '{' + inspect.join(', ') + '}';
      } finally {

        if (top) {
          inspect_ids = null;
        }
      }
    
    };

    def.$invert = function() {
      var self = this;

      
      var result = Opal.hash(),
          keys = self.keys,
          _map = self.map,
          smap = self.smap,
          keys2 = result.keys,
          _map2 = result.map,
          smap2 = result.smap,
          map, map2, key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          map = smap;
          khash = key;
        } else {
          map = _map;
          khash = key.$hash();
        }

        value = map[khash];
        keys2.push(value);

        if (value.$$is_string) {
          map2 = smap2;
          khash = value;
        } else {
          map2 = _map2;
          khash = value.$hash();
        }

        map2[khash] = key;
      }

      return result;
    
    };

    def.$keep_if = TMP_8 = function() {
      var self = this, $iter = TMP_8.$$p, block = $iter || nil;

      TMP_8.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("keep_if")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          map, key, khash, value, keep;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];
        keep  = block(key, value);

        if (keep === $breaker) {
          return $breaker.$v;
        }

        if (keep === false || keep === nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
        }
      }

      return self;
    
    };

    Opal.defn(self, '$key', def.$index);

    Opal.defn(self, '$key?', def['$has_key?']);

    def.$keys = function() {
      var self = this;

      return self.keys.slice(0);
    };

    def.$length = function() {
      var self = this;

      return self.keys.length;
    };

    Opal.defn(self, '$member?', def['$has_key?']);

    def.$merge = TMP_9 = function(other) {
      var $a, $b, self = this, $iter = TMP_9.$$p, block = $iter || nil, cloned = nil;

      TMP_9.$$p = null;
      if ((($a = $scope.get('Hash')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash")
      };
      cloned = self.$clone();
      ($a = ($b = cloned)['$merge!'], $a.$$p = block.$to_proc(), $a).call($b, other);
      return cloned;
    };

    def['$merge!'] = TMP_10 = function(other) {
      var self = this, $iter = TMP_10.$$p, block = $iter || nil;

      TMP_10.$$p = null;
      
      if (! $scope.get('Hash')['$==='](other)) {
        other = $scope.get('Opal')['$coerce_to!'](other, $scope.get('Hash'), "to_hash");
      }

      var keys  = self.keys,
          _map  = self.map,
          smap  = self.smap,
          keys2 = other.keys,
          _map2 = other.map,
          smap2 = other.smap,
          map, map2, key, khash, value, value2;

      if (block === nil) {
        for (var i = 0, length = keys2.length; i < length; i++) {
          key = keys2[i];

          if (key.$$is_string) {
            khash = key;
            map = smap;
            map2 = smap2;
          } else {
            khash = key.$hash();
            map = _map;
            map2 = _map2;
          }

          if (map[khash] == null) {
            keys.push(key);
          }

          map[khash] = map2[khash];
        }
      }
      else {
        for (var i = 0, length = keys2.length; i < length; i++) {
          key    = keys2[i];

          if (key.$$is_string) {
            khash = key;
            map = smap;
            map2 = smap2;
          } else {
            khash = key.$hash();
            map = _map;
            map2 = _map2;
          }

          value  = map[khash];
          value2 = map2[khash];

          if (value == null) {
            keys.push(key);
            map[khash] = value2;
          }
          else {
            map[khash] = block(key, value, value2);
          }
        }
      }

      return self;
    ;
    };

    def.$rassoc = function(object) {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          key, khash, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i]

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];

        if ((value)['$=='](object)) {
          return [key, value];
        }
      }

      return nil;
    
    };

    def.$reject = TMP_11 = function() {
      var self = this, $iter = TMP_11.$$p, block = $iter || nil;

      TMP_11.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("reject")
      };
      
      var keys   = self.keys,
          _map    = self.map,
          smap    = self.smap,
          result = Opal.hash(),
          _map2   = result.map,
          smap2   = result.smap,
          keys2  = result.keys,
          map, map2, key, khash, object, value;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        object = map[khash];

        if ((value = block(key, object)) === $breaker) {
          return $breaker.$v;
        }

        if (value === false || value === nil) {
          keys2.push(key);
          map2[khash] = object;
        }
      }

      return result;
    
    };

    def.$replace = function(other) {
      var self = this;

      
      var keys  = self.keys = [],
          _map  = self.map  = {},
          smap  = self.smap = {},
          _map2 = other.map,
          smap2 = other.smap,
          key, khash, map, map2;

      for (var i = 0, length = other.keys.length; i < length; i++) {
        key = other.keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        keys.push(key);
        map[khash] = map2[khash];
      }

      return self;
    
    };

    def.$select = TMP_12 = function() {
      var self = this, $iter = TMP_12.$$p, block = $iter || nil;

      TMP_12.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select")
      };
      
      var keys   = self.keys,
          _map   = self.map,
          smap   = self.smap,
          result = Opal.hash(),
          _map2  = result.map,
          smap2  = result.smap,
          keys2  = result.keys,
          map, map2, key, khash, value, object;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
          map2 = smap2;
        } else {
          khash = key.$hash();
          map = _map;
          map2 = _map2;
        }

        value = map[khash];
        object = block(key, value);

        if (object === $breaker) {
          return $breaker.$v;
        }

        if (object !== false && object !== nil) {
          keys2.push(key);
          map2[khash] = value;
        }
      }

      return result;
    
    };

    def['$select!'] = TMP_13 = function() {
      var self = this, $iter = TMP_13.$$p, block = $iter || nil;

      TMP_13.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("select!")
      };
      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = nil,
          key, khash, value, object;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        value = map[khash];
        object = block(key, value);

        if (object === $breaker) {
          return $breaker.$v;
        }

        if (object === false || object === nil) {
          keys.splice(i, 1);
          delete map[khash];

          length--;
          i--;
          result = self
        }
      }

      return result;
    
    };

    def.$shift = function() {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          map, key, khash, value;

      if (keys.length) {
        key = keys[0];
        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }
        value = map[khash];

        delete map[khash];
        keys.splice(0, 1);

        return [key, value];
      }

      return nil;
    
    };

    Opal.defn(self, '$size', def.$length);

    self.$alias_method("store", "[]=");

    def.$to_a = function() {
      var self = this;

      
      var keys = self.keys,
          _map = self.map,
          smap = self.smap,
          result = [],
          map, key;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        result.push([key, map[khash]]);
      }

      return result;
    
    };

    def.$to_h = function() {
      var self = this;

      
      if (self.$$class === Opal.Hash) {
        return self
      }

      var hash   = new Opal.Hash.$$alloc,
          cloned = self.$clone();

      hash.map  = cloned.map;
      hash.smap = cloned.smap;
      hash.keys = cloned.keys;
      hash.none = cloned.none;
      hash.proc = cloned.proc;

      return hash;
    ;
    };

    def.$to_hash = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$to_s', def.$inspect);

    Opal.defn(self, '$update', def['$merge!']);

    Opal.defn(self, '$value?', def['$has_value?']);

    Opal.defn(self, '$values_at', def.$indexes);

    return (def.$values = function() {
      var self = this;

      
      var _map = self.map,
          smap = self.smap,
          keys = self.keys,
          result = [],
          map, khash;

      for (var i = 0, length = keys.length; i < length; i++) {
        key = keys[i];

        if (key.$$is_string) {
          khash = key;
          map = smap;
        } else {
          khash = key.$hash();
          map = _map;
        }

        result.push(map[khash]);
      }

      return result;
    
    }, nil) && 'values';
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/string"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$require', '$include', '$to_str', '$===', '$format', '$coerce_to', '$to_s', '$respond_to?', '$<=>', '$raise', '$=~', '$empty?', '$ljust', '$ceil', '$/', '$+', '$rjust', '$floor', '$to_a', '$each_char', '$to_proc', '$coerce_to!', '$initialize_clone', '$initialize_dup', '$enum_for', '$split', '$chomp', '$escape', '$class', '$to_i', '$!', '$each_line', '$match', '$new', '$try_convert', '$chars', '$&', '$join', '$is_a?', '$[]', '$str', '$value', '$proc', '$shift', '$__send__']);
  self.$require("corelib/comparable");
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6, TMP_7;

    def.length = nil;
    self.$include($scope.get('Comparable'));

    def.$$is_string = true;

    Opal.defs(self, '$try_convert', function(what) {
      var self = this;

      try {
      return what.$to_str()
      } catch ($err) {if (true) {
        return nil
        }else { throw $err; }
      };
    });

    Opal.defs(self, '$new', function(str) {
      var self = this;

      if (str == null) {
        str = ""
      }
      return new String(str);
    });

    def['$%'] = function(data) {
      var $a, self = this;

      if ((($a = $scope.get('Array')['$==='](data)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return ($a = self).$format.apply($a, [self].concat(data))
        } else {
        return self.$format(self, data)
      };
    };

    def['$*'] = function(count) {
      var self = this;

      
      if (count < 1) {
        return '';
      }

      var result  = '',
          pattern = self;

      while (count > 0) {
        if (count & 1) {
          result += pattern;
        }

        count >>= 1;
        pattern += pattern;
      }

      return result;
    
    };

    def['$+'] = function(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str");
      return self + other.$to_s();
    };

    def['$<=>'] = function(other) {
      var $a, self = this;

      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        other = other.$to_str().$to_s();
        return self > other ? 1 : (self < other ? -1 : 0);
        } else {
        
        var cmp = other['$<=>'](self);

        if (cmp === nil) {
          return nil;
        }
        else {
          return cmp > 0 ? -1 : (cmp < 0 ? 1 : 0);
        }
      ;
      };
    };

    def['$<<'] = function(other) {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'), "#<< not supported. Mutable String methods are not supported in Opal.");
    };

    def['$=='] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('String')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return self.$to_s() == other.$to_s();
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$===', def['$==']);

    def['$=~'] = function(other) {
      var self = this;

      
      if (other.$$is_string) {
        self.$raise($scope.get('TypeError'), "type mismatch: String given");
      }

      return other['$=~'](self);
    ;
    };

    def['$[]'] = function(index, length) {
      var self = this;

      
      var size = self.length;

      if (index.$$is_range) {
        var exclude = index.exclude,
            length  = index.end,
            index   = index.begin;

        if (index < 0) {
          index += size;
        }

        if (length < 0) {
          length += size;
        }

        if (!exclude) {
          length += 1;
        }

        if (index > size) {
          return nil;
        }

        length = length - index;

        if (length < 0) {
          length = 0;
        }

        return self.substr(index, length);
      }

      if (index < 0) {
        index += self.length;
      }

      if (length == null) {
        if (index >= self.length || index < 0) {
          return nil;
        }

        return self.substr(index, 1);
      }

      if (index > self.length || index < 0) {
        return nil;
      }

      return self.substr(index, length);
    
    };

    def.$capitalize = function() {
      var self = this;

      return self.charAt(0).toUpperCase() + self.substr(1).toLowerCase();
    };

    Opal.defn(self, '$capitalize!', def['$<<']);

    def.$casecmp = function(other) {
      var self = this;

      other = $scope.get('Opal').$coerce_to(other, $scope.get('String'), "to_str").$to_s();
      return (self.toLowerCase())['$<=>'](other.toLowerCase());
    };

    def.$center = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var ljustified = self.$ljust((width['$+'](self.length))['$/'](2).$ceil(), padstr),
          rjustified = self.$rjust((width['$+'](self.length))['$/'](2).$floor(), padstr);

      return rjustified + ljustified.slice(self.length);
    ;
    };

    def.$chars = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$each_char().$to_a()
      };
      return ($a = ($b = self).$each_char, $a.$$p = block.$to_proc(), $a).call($b);
    };

    def.$chomp = function(separator) {
      var $a, self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      if ((($a = separator === nil || self.length === 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      separator = $scope.get('Opal')['$coerce_to!'](separator, $scope.get('String'), "to_str").$to_s();
      
      if (separator === "\n") {
        return self.replace(/\r?\n?$/, '');
      }
      else if (separator === "") {
        return self.replace(/(\r?\n)+$/, '');
      }
      else if (self.length > separator.length) {
        var tail = self.substr(self.length - separator.length, separator.length);

        if (tail === separator) {
          return self.substr(0, self.length - separator.length);
        }
      }
    
      return self;
    };

    Opal.defn(self, '$chomp!', def['$<<']);

    def.$chop = function() {
      var self = this;

      
      var length = self.length;

      if (length <= 1) {
        return "";
      }

      if (self.charAt(length - 1) === "\n" && self.charAt(length - 2) === "\r") {
        return self.substr(0, length - 2);
      }
      else {
        return self.substr(0, length - 1);
      }
    
    };

    Opal.defn(self, '$chop!', def['$<<']);

    def.$chr = function() {
      var self = this;

      return self.charAt(0);
    };

    def.$clone = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_clone(self);
      return copy;
    };

    def.$dup = function() {
      var self = this, copy = nil;

      copy = self.slice();
      copy.$initialize_dup(self);
      return copy;
    };

    def.$count = function(str) {
      var self = this;

      return (self.length - self.replace(new RegExp(str, 'g'), '').length) / str.length;
    };

    Opal.defn(self, '$dup', def.$clone);

    def.$downcase = function() {
      var self = this;

      return self.toLowerCase();
    };

    Opal.defn(self, '$downcase!', def['$<<']);

    def.$each_char = TMP_2 = function() {
      var $a, self = this, $iter = TMP_2.$$p, block = $iter || nil;

      TMP_2.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each_char")
      };
      
      for (var i = 0, length = self.length; i < length; i++) {
        ((($a = Opal.yield1(block, self.charAt(i))) === $breaker) ? $breaker.$v : $a);
      }
    
      return self;
    };

    def.$each_line = TMP_3 = function(separator) {
      var $a, self = this, $iter = TMP_3.$$p, $yield = $iter || nil;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      TMP_3.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$split(separator)
      };
      
      var chomped  = self.$chomp(),
          trailing = self.length != chomped.length,
          splitted = chomped.split(separator);

      for (var i = 0, length = splitted.length; i < length; i++) {
        if (i < length - 1 || trailing) {
          ((($a = Opal.yield1($yield, splitted[i] + separator)) === $breaker) ? $breaker.$v : $a);
        }
        else {
          ((($a = Opal.yield1($yield, splitted[i])) === $breaker) ? $breaker.$v : $a);
        }
      }
    ;
      return self;
    };

    def['$empty?'] = function() {
      var self = this;

      return self.length === 0;
    };

    def['$end_with?'] = function(suffixes) {
      var self = this;

      suffixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = suffixes.length; i < length; i++) {
        var suffix = $scope.get('Opal').$coerce_to(suffixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.length >= suffix.length &&
            self.substr(self.length - suffix.length, suffix.length) == suffix) {
          return true;
        }
      }
    
      return false;
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$equal?', def['$===']);

    def.$gsub = TMP_4 = function(pattern, replace) {
      var $a, $b, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      TMP_4.$$p = null;
      if ((($a = ((($b = $scope.get('String')['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a.$$is_boolean || $a == true))) {
        pattern = (new RegExp("" + $scope.get('Regexp').$escape(pattern.$to_str())))};
      if ((($a = $scope.get('Regexp')['$==='](pattern)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      
      var pattern = pattern.toString(),
          options = pattern.substr(pattern.lastIndexOf('/') + 1) + 'g',
          regexp  = pattern.substr(1, pattern.lastIndexOf('/') - 1);

      self.$sub.$$p = block;
      return self.$sub(new RegExp(regexp, options), replace);
    
    };

    Opal.defn(self, '$gsub!', def['$<<']);

    def.$hash = function() {
      var self = this;

      return self.toString();
    };

    def.$hex = function() {
      var self = this;

      return self.$to_i(16);
    };

    def['$include?'] = function(other) {
      var $a, self = this;

      
      if (other.$$is_string) {
        return self.indexOf(other) !== -1;
      }
    
      if ((($a = other['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "no implicit conversion of " + (other.$class()) + " into String")
      };
      return self.indexOf(other.$to_str()) !== -1;
    };

    def.$index = function(what, offset) {
      var $a, self = this, result = nil;

      if (offset == null) {
        offset = nil
      }
      if ((($a = $scope.get('String')['$==='](what)) !== nil && (!$a.$$is_boolean || $a == true))) {
        what = what.$to_s()
      } else if ((($a = what['$respond_to?']("to_str")) !== nil && (!$a.$$is_boolean || $a == true))) {
        what = what.$to_str().$to_s()
      } else if ((($a = $scope.get('Regexp')['$==='](what)['$!']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "type mismatch: " + (what.$class()) + " given")};
      result = -1;
      if (offset !== false && offset !== nil) {
        offset = $scope.get('Opal').$coerce_to(offset, $scope.get('Integer'), "to_int");
        
        var size = self.length;

        if (offset < 0) {
          offset = offset + size;
        }

        if (offset > size) {
          return nil;
        }
      
        if ((($a = $scope.get('Regexp')['$==='](what)) !== nil && (!$a.$$is_boolean || $a == true))) {
          result = ((($a = (what['$=~'](self.substr(offset)))) !== false && $a !== nil) ? $a : -1)
          } else {
          result = self.substr(offset).indexOf(what)
        };
        
        if (result !== -1) {
          result += offset;
        }
      
      } else if ((($a = $scope.get('Regexp')['$==='](what)) !== nil && (!$a.$$is_boolean || $a == true))) {
        result = ((($a = (what['$=~'](self))) !== false && $a !== nil) ? $a : -1)
        } else {
        result = self.indexOf(what)
      };
      if ((($a = result === -1) !== nil && (!$a.$$is_boolean || $a == true))) {
        return nil
        } else {
        return result
      };
    };

    def.$inspect = function() {
      var self = this;

      
      var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
          meta      = {
            '\b': '\\b',
            '\t': '\\t',
            '\n': '\\n',
            '\f': '\\f',
            '\r': '\\r',
            '"' : '\\"',
            '\\': '\\\\'
          };

      escapable.lastIndex = 0;

      return escapable.test(self) ? '"' + self.replace(escapable, function(a) {
        var c = meta[a];

        return typeof c === 'string' ? c :
          '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
      }) + '"' : '"' + self + '"';
    
    };

    def.$intern = function() {
      var self = this;

      return self;
    };

    def.$lines = function(separator) {
      var self = this;
      if ($gvars["/"] == null) $gvars["/"] = nil;

      if (separator == null) {
        separator = $gvars["/"]
      }
      return self.$each_line(separator).$to_a();
    };

    def.$length = function() {
      var self = this;

      return self.length;
    };

    def.$ljust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var index  = -1,
          result = "";

      width -= self.length;

      while (++index < width) {
        result += padstr;
      }

      return self + result.slice(0, width);
    
    };

    def.$lstrip = function() {
      var self = this;

      return self.replace(/^\s*/, '');
    };

    Opal.defn(self, '$lstrip!', def['$<<']);

    def.$match = TMP_5 = function(pattern, pos) {
      var $a, $b, self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if ((($a = ((($b = $scope.get('String')['$==='](pattern)) !== false && $b !== nil) ? $b : pattern['$respond_to?']("to_str"))) !== nil && (!$a.$$is_boolean || $a == true))) {
        pattern = (new RegExp("" + $scope.get('Regexp').$escape(pattern.$to_str())))};
      if ((($a = $scope.get('Regexp')['$==='](pattern)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "wrong argument type " + (pattern.$class()) + " (expected Regexp)")
      };
      return ($a = ($b = pattern).$match, $a.$$p = block.$to_proc(), $a).call($b, self, pos);
    };

    def.$next = function() {
      var self = this;

      
      if (self.length === 0) {
        return "";
      }

      var initial = self.substr(0, self.length - 1);
      var last    = String.fromCharCode(self.charCodeAt(self.length - 1) + 1);

      return initial + last;
    
    };

    Opal.defn(self, '$next!', def['$<<']);

    def.$ord = function() {
      var self = this;

      return self.charCodeAt(0);
    };

    def.$partition = function(str) {
      var self = this;

      
      var result = self.split(str);
      var splitter = (result[0].length === self.length ? "" : str);

      return [result[0], splitter, result.slice(1).join(str.toString())];
    
    };

    def.$reverse = function() {
      var self = this;

      return self.split('').reverse().join('');
    };

    Opal.defn(self, '$reverse!', def['$<<']);

    def.$rindex = function(search, offset) {
      var self = this;

      
      var search_type = (search == null ? Opal.NilClass : search.constructor);
      if (search_type != String && search_type != RegExp) {
        var msg = "type mismatch: " + search_type + " given";
        self.$raise($scope.get('TypeError').$new(msg));
      }

      if (self.length == 0) {
        return search.length == 0 ? 0 : nil;
      }

      var result = -1;
      if (offset != null) {
        if (offset < 0) {
          offset = self.length + offset;
        }

        if (search_type == String) {
          result = self.lastIndexOf(search, offset);
        }
        else {
          result = self.substr(0, offset + 1).$reverse().search(search);
          if (result !== -1) {
            result = offset - result;
          }
        }
      }
      else {
        if (search_type == String) {
          result = self.lastIndexOf(search);
        }
        else {
          result = self.$reverse().search(search);
          if (result !== -1) {
            result = self.length - 1 - result;
          }
        }
      }

      return result === -1 ? nil : result;
    
    };

    def.$rjust = function(width, padstr) {
      var $a, self = this;

      if (padstr == null) {
        padstr = " "
      }
      width = $scope.get('Opal').$coerce_to(width, $scope.get('Integer'), "to_int");
      padstr = $scope.get('Opal').$coerce_to(padstr, $scope.get('String'), "to_str").$to_s();
      if ((($a = padstr['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "zero width padding")};
      if ((($a = width <= self.length) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self};
      
      var chars     = Math.floor(width - self.length),
          patterns  = Math.floor(chars / padstr.length),
          result    = Array(patterns + 1).join(padstr),
          remaining = chars - result.length;

      return result + padstr.slice(0, remaining) + self;
    
    };

    def.$rstrip = function() {
      var self = this;

      return self.replace(/\s*$/, '');
    };

    def.$scan = TMP_6 = function(pattern) {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      
      if (pattern.global) {
        // should we clear it afterwards too?
        pattern.lastIndex = 0;
      }
      else {
        // rewrite regular expression to add the global flag to capture pre/post match
        pattern = new RegExp(pattern.source, 'g' + (pattern.multiline ? 'm' : '') + (pattern.ignoreCase ? 'i' : ''));
      }

      var result = [];
      var match;

      while ((match = pattern.exec(self)) != null) {
        var match_data = $scope.get('MatchData').$new(pattern, match);
        if (block === nil) {
          match.length == 1 ? result.push(match[0]) : result.push(match.slice(1));
        }
        else {
          match.length == 1 ? block(match[0]) : block.apply(self, match.slice(1));
        }
      }

      return (block !== nil ? self : result);
    
    };

    Opal.defn(self, '$size', def.$length);

    Opal.defn(self, '$slice', def['$[]']);

    Opal.defn(self, '$slice!', def['$<<']);

    def.$split = function(pattern, limit) {
      var self = this, $a;
      if ($gvars[";"] == null) $gvars[";"] = nil;

      if (pattern == null) {
        pattern = ((($a = $gvars[";"]) !== false && $a !== nil) ? $a : " ")
      }
      
      if (pattern === nil || pattern === undefined) {
        pattern = $gvars[";"];
      }

      var result = [];
      if (limit !== undefined) {
        limit = $scope.get('Opal')['$coerce_to!'](limit, $scope.get('Integer'), "to_int");
      }

      if (self.length === 0) {
        return [];
      }

      if (limit === 1) {
        return [self];
      }

      if (pattern && pattern.$$is_regexp) {
        var pattern_str = pattern.toString();

        /* Opal and JS's repr of an empty RE. */
        var blank_pattern = (pattern_str.substr(0, 3) == '/^/') ||
                  (pattern_str.substr(0, 6) == '/(?:)/');

        /* This is our fast path */
        if (limit === undefined || limit === 0) {
          result = self.split(blank_pattern ? /(?:)/ : pattern);
        }
        else {
          /* RegExp.exec only has sane behavior with global flag */
          if (! pattern.global) {
            pattern = eval(pattern_str + 'g');
          }

          var match_data;
          var prev_index = 0;
          pattern.lastIndex = 0;

          while ((match_data = pattern.exec(self)) !== null) {
            var segment = self.slice(prev_index, match_data.index);
            result.push(segment);

            prev_index = pattern.lastIndex;

            if (match_data[0].length === 0) {
              if (blank_pattern) {
                /* explicitly split on JS's empty RE form.*/
                pattern = /(?:)/;
              }

              result = self.split(pattern);
              /* with "unlimited", ruby leaves a trail on blanks. */
              if (limit !== undefined && limit < 0 && blank_pattern) {
                result.push('');
              }

              prev_index = undefined;
              break;
            }

            if (limit !== undefined && limit > 1 && result.length + 1 == limit) {
              break;
            }
          }

          if (prev_index !== undefined) {
            result.push(self.slice(prev_index, self.length));
          }
        }
      }
      else {
        var splitted = 0, start = 0, lim = 0;

        if (pattern === nil || pattern === undefined) {
          pattern = ' '
        } else {
          pattern = $scope.get('Opal').$try_convert(pattern, $scope.get('String'), "to_str").$to_s();
        }

        var string = (pattern == ' ') ? self.replace(/[\r\n\t\v]\s+/g, ' ')
                                      : self;
        var cursor = -1;
        while ((cursor = string.indexOf(pattern, start)) > -1 && cursor < string.length) {
          if (splitted + 1 === limit) {
            break;
          }

          if (pattern == ' ' && cursor == start) {
            start = cursor + 1;
            continue;
          }

          result.push(string.substr(start, pattern.length ? cursor - start : 1));
          splitted++;

          start = cursor + (pattern.length ? pattern.length : 1);
        }

        if (string.length > 0 && (limit < 0 || string.length > start)) {
          if (string.length == start) {
            result.push('');
          }
          else {
            result.push(string.substr(start, string.length));
          }
        }
      }

      if (limit === undefined || limit === 0) {
        while (result[result.length-1] === '') {
          result.length = result.length - 1;
        }
      }

      if (limit > 0) {
        var tail = result.slice(limit - 1).join('');
        result.splice(limit - 1, result.length - 1, tail);
      }

      return result;
    ;
    };

    def.$squeeze = function(sets) {
      var self = this;

      sets = $slice.call(arguments, 0);
      
      if (sets.length === 0) {
        return self.replace(/(.)\1+/g, '$1');
      }
    
      
      var set = $scope.get('Opal').$coerce_to(sets[0], $scope.get('String'), "to_str").$chars();

      for (var i = 1, length = sets.length; i < length; i++) {
        set = (set)['$&']($scope.get('Opal').$coerce_to(sets[i], $scope.get('String'), "to_str").$chars());
      }

      if (set.length === 0) {
        return self;
      }

      return self.replace(new RegExp("([" + $scope.get('Regexp').$escape((set).$join()) + "])\\1+", "g"), "$1");
    ;
    };

    Opal.defn(self, '$squeeze!', def['$<<']);

    def['$start_with?'] = function(prefixes) {
      var self = this;

      prefixes = $slice.call(arguments, 0);
      
      for (var i = 0, length = prefixes.length; i < length; i++) {
        var prefix = $scope.get('Opal').$coerce_to(prefixes[i], $scope.get('String'), "to_str").$to_s();

        if (self.indexOf(prefix) === 0) {
          return true;
        }
      }

      return false;
    
    };

    def.$strip = function() {
      var self = this;

      return self.replace(/^\s*/, '').replace(/\s*$/, '');
    };

    Opal.defn(self, '$strip!', def['$<<']);

    
    // convert Ruby back reference to JavaScript back reference
    function convertReplace(replace) {
      return replace.replace(
        /(^|[^\\])\\(\d)/g, function(a, b, c) { return b + '$' + c }
      ).replace(
        /(^|[^\\])(\\\\)+\\\\(\d)/g, '$1$2\\$3'
      ).replace(
        /(^|[^\\])(?:(\\)\\)+([^\\]|$)/g, '$1$2$3'
      );
    }
  

    def.$sub = TMP_7 = function(pattern, replace) {
      var self = this, $iter = TMP_7.$$p, block = $iter || nil;

      TMP_7.$$p = null;
      
      if (typeof(pattern) !== 'string' && !pattern.$$is_regexp) {
        pattern = $scope.get('Opal')['$coerce_to!'](pattern, $scope.get('String'), "to_str");
      }

      if (replace !== undefined) {
        if (replace['$is_a?']($scope.get('Hash'))) {
          return self.replace(pattern, function(str) {
            var value = replace['$[]'](self.$str());

            return (value == null) ? nil : self.$value().$to_s();
          });
        }
        else {
          if (typeof(replace) !== 'string') {
            replace = $scope.get('Opal')['$coerce_to!'](replace, $scope.get('String'), "to_str");
          }

          replace = convertReplace(replace);
          return self.replace(pattern, replace);
        }

      }
      else if (block != null && block !== nil) {
        return self.replace(pattern, function() {
          // FIXME: this should be a formal MatchData object with all the goodies
          var match_data = []
          for (var i = 0, len = arguments.length; i < len; i++) {
            var arg = arguments[i];
            if (arg == undefined) {
              match_data.push(nil);
            }
            else {
              match_data.push(arg);
            }
          }

          var str = match_data.pop();
          var offset = match_data.pop();
          var match_len = match_data.length;

          // $1, $2, $3 not being parsed correctly in Ruby code
          for (var i = 1; i < match_len; i++) {
            Opal.gvars[String(i)] = match_data[i];
          }
          $gvars["&"] = match_data[0];
          $gvars["~"] = match_data;
          return block(match_data[0]);
        });
      }
      else {
        self.$raise($scope.get('ArgumentError'), "wrong number of arguments (1 for 2)")
      }
    ;
    };

    Opal.defn(self, '$sub!', def['$<<']);

    Opal.defn(self, '$succ', def.$next);

    Opal.defn(self, '$succ!', def['$<<']);

    def.$sum = function(n) {
      var self = this;

      if (n == null) {
        n = 16
      }
      
      var result = 0;

      for (var i = 0, length = self.length; i < length; i++) {
        result += (self.charCodeAt(i) % ((1 << n) - 1));
      }

      return result;
    
    };

    def.$swapcase = function() {
      var self = this;

      
      var str = self.replace(/([a-z]+)|([A-Z]+)/g, function($0,$1,$2) {
        return $1 ? $0.toUpperCase() : $0.toLowerCase();
      });

      if (self.constructor === String) {
        return str;
      }

      return self.$class().$new(str);
    
    };

    Opal.defn(self, '$swapcase!', def['$<<']);

    def.$to_f = function() {
      var self = this;

      
      if (self.charAt(0) === '_') {
        return 0;
      }

      var result = parseFloat(self.replace(/_/g, ''));

      if (isNaN(result) || result == Infinity || result == -Infinity) {
        return 0;
      }
      else {
        return result;
      }
    
    };

    def.$to_i = function(base) {
      var self = this;

      if (base == null) {
        base = 10
      }
      
      var result = parseInt(self, base);

      if (isNaN(result)) {
        return 0;
      }

      return result;
    
    };

    def.$to_proc = function() {
      var $a, $b, TMP_8, self = this, sym = nil;

      sym = self;
      return ($a = ($b = self).$proc, $a.$$p = (TMP_8 = function(args){var self = TMP_8.$$s || this, block, $a, $b, obj = nil;
args = $slice.call(arguments, 0);
        block = TMP_8.$$p || nil, TMP_8.$$p = null;
      if ((($a = args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$raise($scope.get('ArgumentError'), "no receiver given")};
        obj = args.$shift();
        return ($a = ($b = obj).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [sym].concat(args));}, TMP_8.$$s = self, TMP_8), $a).call($b);
    };

    def.$to_s = function() {
      var self = this;

      return self.toString();
    };

    Opal.defn(self, '$to_str', def.$to_s);

    Opal.defn(self, '$to_sym', def.$intern);

    def.$tr = function(from, to) {
      var self = this;

      
      if (from.length == 0 || from === to) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }

      var new_str = ''
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch];
        if (inverse) {
          new_str += (sub == null ? global_sub : ch);
        }
        else {
          new_str += (sub != null ? sub : ch);
        }
      }
      return new_str;
    
    };

    Opal.defn(self, '$tr!', def['$<<']);

    def.$tr_s = function(from, to) {
      var self = this;

      
      if (from.length == 0) {
        return self;
      }

      var subs = {};
      var from_chars = from.split('');
      var from_length = from_chars.length;
      var to_chars = to.split('');
      var to_length = to_chars.length;

      var inverse = false;
      var global_sub = null;
      if (from_chars[0] === '^') {
        inverse = true;
        from_chars.shift();
        global_sub = to_chars[to_length - 1]
        from_length -= 1;
      }

      var from_chars_expanded = [];
      var last_from = null;
      var in_range = false;
      for (var i = 0; i < from_length; i++) {
        var ch = from_chars[i];
        if (last_from == null) {
          last_from = ch;
          from_chars_expanded.push(ch);
        }
        else if (ch === '-') {
          if (last_from === '-') {
            from_chars_expanded.push('-');
            from_chars_expanded.push('-');
          }
          else if (i == from_length - 1) {
            from_chars_expanded.push('-');
          }
          else {
            in_range = true;
          }
        }
        else if (in_range) {
          var start = last_from.charCodeAt(0) + 1;
          var end = ch.charCodeAt(0);
          for (var c = start; c < end; c++) {
            from_chars_expanded.push(String.fromCharCode(c));
          }
          from_chars_expanded.push(ch);
          in_range = null;
          last_from = null;
        }
        else {
          from_chars_expanded.push(ch);
        }
      }

      from_chars = from_chars_expanded;
      from_length = from_chars.length;

      if (inverse) {
        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = true;
        }
      }
      else {
        if (to_length > 0) {
          var to_chars_expanded = [];
          var last_to = null;
          var in_range = false;
          for (var i = 0; i < to_length; i++) {
            var ch = to_chars[i];
            if (last_from == null) {
              last_from = ch;
              to_chars_expanded.push(ch);
            }
            else if (ch === '-') {
              if (last_to === '-') {
                to_chars_expanded.push('-');
                to_chars_expanded.push('-');
              }
              else if (i == to_length - 1) {
                to_chars_expanded.push('-');
              }
              else {
                in_range = true;
              }
            }
            else if (in_range) {
              var start = last_from.charCodeAt(0) + 1;
              var end = ch.charCodeAt(0);
              for (var c = start; c < end; c++) {
                to_chars_expanded.push(String.fromCharCode(c));
              }
              to_chars_expanded.push(ch);
              in_range = null;
              last_from = null;
            }
            else {
              to_chars_expanded.push(ch);
            }
          }

          to_chars = to_chars_expanded;
          to_length = to_chars.length;
        }

        var length_diff = from_length - to_length;
        if (length_diff > 0) {
          var pad_char = (to_length > 0 ? to_chars[to_length - 1] : '');
          for (var i = 0; i < length_diff; i++) {
            to_chars.push(pad_char);
          }
        }

        for (var i = 0; i < from_length; i++) {
          subs[from_chars[i]] = to_chars[i];
        }
      }
      var new_str = ''
      var last_substitute = null
      for (var i = 0, length = self.length; i < length; i++) {
        var ch = self.charAt(i);
        var sub = subs[ch]
        if (inverse) {
          if (sub == null) {
            if (last_substitute == null) {
              new_str += global_sub;
              last_substitute = true;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
        else {
          if (sub != null) {
            if (last_substitute == null || last_substitute !== sub) {
              new_str += sub;
              last_substitute = sub;
            }
          }
          else {
            new_str += ch;
            last_substitute = null;
          }
        }
      }
      return new_str;
    
    };

    Opal.defn(self, '$tr_s!', def['$<<']);

    def.$upcase = function() {
      var self = this;

      return self.toUpperCase();
    };

    Opal.defn(self, '$upcase!', def['$<<']);

    def.$freeze = function() {
      var self = this;

      return self;
    };

    return (def['$frozen?'] = function() {
      var self = this;

      return true;
    }, nil) && 'frozen?';
  })(self, null);
  return Opal.cdecl($scope, 'Symbol', $scope.get('String'));
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/string/inheritance"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$new', '$allocate', '$initialize', '$to_proc', '$__send__', '$class', '$clone', '$respond_to?', '$==', '$inspect']);
  (function($base, $super) {
    function $String(){};
    var self = $String = $klass($base, $super, 'String', $String);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$inherited', function(klass) {
      var self = this, replace = nil;

      replace = $scope.get('Class').$new((($scope.get('String')).$$scope.get('Wrapper')));
      
      klass.$$proto         = replace.$$proto;
      klass.$$proto.$$class = klass;
      klass.$$alloc         = replace.$$alloc;
      klass.$$parent        = (($scope.get('String')).$$scope.get('Wrapper'));

      klass.$allocate = replace.$allocate;
      klass.$new      = replace.$new;
    
    }), nil) && 'inherited'
  })(self, null);
  return (function($base, $super) {
    function $Wrapper(){};
    var self = $Wrapper = $klass($base, $super, 'Wrapper', $Wrapper);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4;

    def.literal = nil;
    Opal.defs(self, '$allocate', TMP_1 = function(string) {
      var self = this, $iter = TMP_1.$$p, $yield = $iter || nil, obj = nil;

      if (string == null) {
        string = ""
      }
      TMP_1.$$p = null;
      obj = Opal.find_super_dispatcher(self, 'allocate', TMP_1, null, $Wrapper).apply(self, []);
      obj.literal = string;
      return obj;
    });

    Opal.defs(self, '$new', TMP_2 = function(args) {
      var $a, $b, self = this, $iter = TMP_2.$$p, block = $iter || nil, obj = nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      obj = self.$allocate();
      ($a = ($b = obj).$initialize, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      return obj;
    });

    Opal.defs(self, '$[]', function(objects) {
      var self = this;

      objects = $slice.call(arguments, 0);
      return self.$allocate(objects);
    });

    def.$initialize = function(string) {
      var self = this;

      if (string == null) {
        string = ""
      }
      return self.literal = string;
    };

    def.$method_missing = TMP_3 = function(args) {
      var $a, $b, self = this, $iter = TMP_3.$$p, block = $iter || nil, result = nil;

      args = $slice.call(arguments, 0);
      TMP_3.$$p = null;
      result = ($a = ($b = self.literal).$__send__, $a.$$p = block.$to_proc(), $a).apply($b, [].concat(args));
      if ((($a = result.$$is_string != null) !== nil && (!$a.$$is_boolean || $a == true))) {
        if ((($a = result == self.literal) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self
          } else {
          return self.$class().$allocate(result)
        }
        } else {
        return result
      };
    };

    def.$initialize_copy = function(other) {
      var self = this;

      return self.literal = (other.literal).$clone();
    };

    def['$respond_to?'] = TMP_4 = function(name) {var $zuper = $slice.call(arguments, 0);
      var $a, self = this, $iter = TMP_4.$$p, $yield = $iter || nil;

      TMP_4.$$p = null;
      return ((($a = Opal.find_super_dispatcher(self, 'respond_to?', TMP_4, $iter).apply(self, $zuper)) !== false && $a !== nil) ? $a : self.literal['$respond_to?'](name));
    };

    def['$=='] = function(other) {
      var self = this;

      return self.literal['$=='](other);
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$===', def['$==']);

    def.$to_s = function() {
      var self = this;

      return self.literal;
    };

    def.$to_str = function() {
      var self = this;

      return self;
    };

    return (def.$inspect = function() {
      var self = this;

      return self.literal.$inspect();
    }, nil) && 'inspect';
  })($scope.get('String'), null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/match_data"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $gvars = Opal.gvars;

  Opal.add_stubs(['$attr_reader', '$[]', '$===', '$!', '$==', '$raise', '$inspect']);
  return (function($base, $super) {
    function $MatchData(){};
    var self = $MatchData = $klass($base, $super, 'MatchData', $MatchData);

    var def = self.$$proto, $scope = self.$$scope;

    def.string = def.matches = def.begin = nil;
    self.$attr_reader("post_match", "pre_match", "regexp", "string");

    def.$initialize = function(regexp, match_groups) {
      var self = this;

      $gvars["~"] = self;
      self.regexp = regexp;
      self.begin = match_groups.index;
      self.string = match_groups.input;
      self.pre_match = self.string.substr(0, regexp.lastIndex - match_groups[0].length);
      self.post_match = self.string.substr(regexp.lastIndex);
      self.matches = [];
      
      for (var i = 0, length = match_groups.length; i < length; i++) {
        var group = match_groups[i];

        if (group == null) {
          self.matches.push(nil);
        }
        else {
          self.matches.push(group);
        }
      }
    
    };

    def['$[]'] = function(args) {
      var $a, self = this;

      args = $slice.call(arguments, 0);
      return ($a = self.matches)['$[]'].apply($a, [].concat(args));
    };

    def['$=='] = function(other) {
      var $a, $b, $c, $d, self = this;

      if ((($a = $scope.get('MatchData')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = ($c = ($d = self.string == other.string, $d !== false && $d !== nil ?self.regexp == other.regexp : $d), $c !== false && $c !== nil ?self.pre_match == other.pre_match : $c), $b !== false && $b !== nil ?self.post_match == other.post_match : $b), $a !== false && $a !== nil ?self.begin == other.begin : $a);
    };

    def.$begin = function(pos) {
      var $a, $b, self = this;

      if ((($a = ($b = pos['$=='](0)['$!'](), $b !== false && $b !== nil ?pos['$=='](1)['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "MatchData#begin only supports 0th element")};
      return self.begin;
    };

    def.$captures = function() {
      var self = this;

      return self.matches.slice(1);
    };

    def.$inspect = function() {
      var self = this;

      
      var str = "#<MatchData " + (self.matches[0]).$inspect();

      for (var i = 1, length = self.matches.length; i < length; i++) {
        str += " " + i + ":" + (self.matches[i]).$inspect();
      }

      return str + ">";
    ;
    };

    def.$length = function() {
      var self = this;

      return self.matches.length;
    };

    Opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var self = this;

      return self.matches;
    };

    def.$to_s = function() {
      var self = this;

      return self.matches[0];
    };

    return (def.$values_at = function(indexes) {
      var self = this;

      indexes = $slice.call(arguments, 0);
      
      var values       = [],
          match_length = self.matches.length;

      for (var i = 0, length = indexes.length; i < length; i++) {
        var pos = indexes[i];

        if (pos >= 0) {
          values.push(self.matches[pos]);
        }
        else {
          pos += match_length;

          if (pos > 0) {
            values.push(self.matches[pos]);
          }
          else {
            values.push(nil);
          }
        }
      }

      return values;
    ;
    }, nil) && 'values_at';
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/numeric"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$coerce', '$===', '$raise', '$class', '$__send__', '$send_coerced', '$coerce_to!', '$-@', '$**', '$-', '$respond_to?', '$==', '$enum_for', '$gcd', '$lcm', '$<', '$>', '$floor', '$/', '$%']);
  self.$require("corelib/comparable");
  (function($base, $super) {
    function $Numeric(){};
    var self = $Numeric = $klass($base, $super, 'Numeric', $Numeric);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3, TMP_4, TMP_5, TMP_6;

    self.$include($scope.get('Comparable'));

    def.$$is_number = true;

    def.$coerce = function(other, type) {
      var self = this, $case = nil;

      if (type == null) {
        type = "operation"
      }
      try {
      
      if (other.$$is_number) {
        return [self, other];
      }
      else {
        return other.$coerce(self);
      }
    
      } catch ($err) {if (true) {
        return (function() {$case = type;if ("operation"['$===']($case)) {return self.$raise($scope.get('TypeError'), "" + (other.$class()) + " can't be coerced into Numeric")}else if ("comparison"['$===']($case)) {return self.$raise($scope.get('ArgumentError'), "comparison of " + (self.$class()) + " with " + (other.$class()) + " failed")}else { return nil }})()
        }else { throw $err; }
      };
    };

    def.$send_coerced = function(method, other) {
      var $a, self = this, type = nil, $case = nil, a = nil, b = nil;

      type = (function() {$case = method;if ("+"['$===']($case) || "-"['$===']($case) || "*"['$===']($case) || "/"['$===']($case) || "%"['$===']($case) || "&"['$===']($case) || "|"['$===']($case) || "^"['$===']($case) || "**"['$===']($case)) {return "operation"}else if (">"['$===']($case) || ">="['$===']($case) || "<"['$===']($case) || "<="['$===']($case) || "<=>"['$===']($case)) {return "comparison"}else { return nil }})();
      $a = Opal.to_ary(self.$coerce(other, type)), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]);
      return a.$__send__(method, b);
    };

    def['$+'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self + other;
      }
      else {
        return self.$send_coerced("+", other);
      }
    
    };

    def['$-'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self - other;
      }
      else {
        return self.$send_coerced("-", other);
      }
    
    };

    def['$*'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self * other;
      }
      else {
        return self.$send_coerced("*", other);
      }
    
    };

    def['$/'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self / other;
      }
      else {
        return self.$send_coerced("/", other);
      }
    
    };

    def['$%'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        if (other < 0 || self < 0) {
          return (self % other + other) % other;
        }
        else {
          return self % other;
        }
      }
      else {
        return self.$send_coerced("%", other);
      }
    
    };

    def['$&'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self & other;
      }
      else {
        return self.$send_coerced("&", other);
      }
    
    };

    def['$|'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self | other;
      }
      else {
        return self.$send_coerced("|", other);
      }
    
    };

    def['$^'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self ^ other;
      }
      else {
        return self.$send_coerced("^", other);
      }
    
    };

    def['$<'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self < other;
      }
      else {
        return self.$send_coerced("<", other);
      }
    
    };

    def['$<='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self <= other;
      }
      else {
        return self.$send_coerced("<=", other);
      }
    
    };

    def['$>'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self > other;
      }
      else {
        return self.$send_coerced(">", other);
      }
    
    };

    def['$>='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self >= other;
      }
      else {
        return self.$send_coerced(">=", other);
      }
    
    };

    def['$<=>'] = function(other) {
      var self = this;

      try {
      
      if (other.$$is_number) {
        return self > other ? 1 : (self < other ? -1 : 0);
      }
      else {
        return self.$send_coerced("<=>", other);
      }
    
      } catch ($err) {if (Opal.rescue($err, [$scope.get('ArgumentError')])) {
        return nil
        }else { throw $err; }
      };
    };

    def['$<<'] = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self << count : self >> -count;
    };

    def['$>>'] = function(count) {
      var self = this;

      count = $scope.get('Opal')['$coerce_to!'](count, $scope.get('Integer'), "to_int");
      return count > 0 ? self >> count : self << -count;
    };

    def['$[]'] = function(bit) {
      var self = this, min = nil, max = nil;

      bit = $scope.get('Opal')['$coerce_to!'](bit, $scope.get('Integer'), "to_int");
      min = ((2)['$**'](30))['$-@']();
      max = ((2)['$**'](30))['$-'](1);
      return (bit < min || bit > max) ? 0 : (self >> bit) % 2;
    };

    def['$+@'] = function() {
      var self = this;

      return +self;
    };

    def['$-@'] = function() {
      var self = this;

      return -self;
    };

    def['$~'] = function() {
      var self = this;

      return ~self;
    };

    def['$**'] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return Math.pow(self, other);
      }
      else {
        return self.$send_coerced("**", other);
      }
    
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (other.$$is_number) {
        return self == Number(other);
      }
      else if (other['$respond_to?']("==")) {
        return other['$=='](self);
      }
      else {
        return false;
      }
    ;
    };

    def.$abs = function() {
      var self = this;

      return Math.abs(self);
    };

    def.$ceil = function() {
      var self = this;

      return Math.ceil(self);
    };

    def.$chr = function(encoding) {
      var self = this;

      return String.fromCharCode(self);
    };

    def.$conj = function() {
      var self = this;

      return self;
    };

    Opal.defn(self, '$conjugate', def.$conj);

    def.$downto = TMP_1 = function(finish) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("downto", finish)
      };
      
      for (var i = self; i >= finish; i--) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    Opal.defn(self, '$eql?', def['$==']);

    Opal.defn(self, '$equal?', def['$==']);

    def['$even?'] = function() {
      var self = this;

      return self % 2 === 0;
    };

    def.$floor = function() {
      var self = this;

      return Math.floor(self);
    };

    def.$gcd = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      var min = Math.abs(self),
          max = Math.abs(other);

      while (min > 0) {
        var tmp = min;

        min = max % min;
        max = tmp;
      }

      return max;
    
    };

    def.$gcdlcm = function(other) {
      var self = this;

      return [self.$gcd(), self.$lcm()];
    };

    def.$hash = function() {
      var self = this;

      return 'Numeric:'+self.toString();
    };

    def['$integer?'] = function() {
      var self = this;

      return self % 1 === 0;
    };

    def['$is_a?'] = TMP_2 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, self = this, $iter = TMP_2.$$p, $yield = $iter || nil;

      TMP_2.$$p = null;
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      return Opal.find_super_dispatcher(self, 'is_a?', TMP_2, $iter).apply(self, $zuper);
    };

    Opal.defn(self, '$kind_of?', def['$is_a?']);

    def['$instance_of?'] = TMP_3 = function(klass) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, self = this, $iter = TMP_3.$$p, $yield = $iter || nil;

      TMP_3.$$p = null;
      if ((($a = (($b = klass['$==']($scope.get('Fixnum'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Integer'))) ? $scope.get('Integer')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      if ((($a = (($b = klass['$==']($scope.get('Float'))) ? $scope.get('Float')['$==='](self) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return true};
      return Opal.find_super_dispatcher(self, 'instance_of?', TMP_3, $iter).apply(self, $zuper);
    };

    def.$lcm = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('TypeError'), "not an integer")
      };
      
      if (self == 0 || other == 0) {
        return 0;
      }
      else {
        return Math.abs(self * other / self.$gcd(other));
      }
    
    };

    Opal.defn(self, '$magnitude', def.$abs);

    Opal.defn(self, '$modulo', def['$%']);

    def.$next = function() {
      var self = this;

      return self + 1;
    };

    def['$nonzero?'] = function() {
      var self = this;

      return self == 0 ? nil : self;
    };

    def['$odd?'] = function() {
      var self = this;

      return self % 2 !== 0;
    };

    def.$ord = function() {
      var self = this;

      return self;
    };

    def.$pred = function() {
      var self = this;

      return self - 1;
    };

    def.$round = function(ndigits) {
      var self = this;

      if (ndigits == null) {
        ndigits = 0
      }
      
      var scale = Math.pow(10, ndigits);
      return Math.round(self * scale) / scale;
    
    };

    def.$step = TMP_4 = function(limit, step) {
      var $a, self = this, $iter = TMP_4.$$p, block = $iter || nil;

      if (step == null) {
        step = 1
      }
      TMP_4.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("step", limit, step)
      };
      if ((($a = step == 0) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "step cannot be 0")};
      
      var value = self;

      if (step > 0) {
        while (value <= limit) {
          block(value);
          value += step;
        }
      }
      else {
        while (value >= limit) {
          block(value);
          value += step;
        }
      }
    
      return self;
    };

    Opal.defn(self, '$succ', def.$next);

    def.$times = TMP_5 = function() {
      var self = this, $iter = TMP_5.$$p, block = $iter || nil;

      TMP_5.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("times")
      };
      
      for (var i = 0; i < self; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def.$to_f = function() {
      var self = this;

      return self;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self);
    };

    Opal.defn(self, '$to_int', def.$to_i);

    def.$to_s = function(base) {
      var $a, $b, self = this;

      if (base == null) {
        base = 10
      }
      if ((($a = ((($b = base['$<'](2)) !== false && $b !== nil) ? $b : base['$>'](36))) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('ArgumentError'), "base must be between 2 and 36")};
      return self.toString(base);
    };

    Opal.defn(self, '$inspect', def.$to_s);

    def.$divmod = function(rhs) {
      var self = this, q = nil, r = nil;

      q = (self['$/'](rhs)).$floor();
      r = self['$%'](rhs);
      return [q, r];
    };

    def.$upto = TMP_6 = function(finish) {
      var self = this, $iter = TMP_6.$$p, block = $iter || nil;

      TMP_6.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        return self.$enum_for("upto", finish)
      };
      
      for (var i = self; i <= finish; i++) {
        if (block(i) === $breaker) {
          return $breaker.$v;
        }
      }
    
      return self;
    };

    def['$zero?'] = function() {
      var self = this;

      return self == 0;
    };

    def.$size = function() {
      var self = this;

      return 4;
    };

    def['$nan?'] = function() {
      var self = this;

      return isNaN(self);
    };

    def['$finite?'] = function() {
      var self = this;

      return self != Infinity && self != -Infinity;
    };

    def['$infinite?'] = function() {
      var self = this;

      
      if (self == Infinity) {
        return +1;
      }
      else if (self == -Infinity) {
        return -1;
      }
      else {
        return nil;
      }
    
    };

    def['$positive?'] = function() {
      var self = this;

      return 1 / self > 0;
    };

    return (def['$negative?'] = function() {
      var self = this;

      return 1 / self < 0;
    }, nil) && 'negative?';
  })(self, null);
  Opal.cdecl($scope, 'Fixnum', $scope.get('Numeric'));
  (function($base, $super) {
    function $Integer(){};
    var self = $Integer = $klass($base, $super, 'Integer', $Integer);

    var def = self.$$proto, $scope = self.$$scope;

    return (Opal.defs(self, '$===', function(other) {
      var self = this;

      
      if (!other.$$is_number) {
        return false;
      }

      return (other % 1) === 0;
    
    }), nil) && '==='
  })(self, $scope.get('Numeric'));
  return (function($base, $super) {
    function $Float(){};
    var self = $Float = $klass($base, $super, 'Float', $Float);

    var def = self.$$proto, $scope = self.$$scope, $a;

    Opal.defs(self, '$===', function(other) {
      var self = this;

      return !!other.$$is_number;
    });

    Opal.cdecl($scope, 'INFINITY', Infinity);

    Opal.cdecl($scope, 'NAN', NaN);

    if ((($a = (typeof(Number.EPSILON) !== "undefined")) !== nil && (!$a.$$is_boolean || $a == true))) {
      return Opal.cdecl($scope, 'EPSILON', Number.EPSILON)
      } else {
      return Opal.cdecl($scope, 'EPSILON', 2.2204460492503130808472633361816E-16)
    };
  })(self, $scope.get('Numeric'));
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/complex"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  return (function($base, $super) {
    function $Complex(){};
    var self = $Complex = $klass($base, $super, 'Complex', $Complex);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Numeric'))
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/rational"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  return (function($base, $super) {
    function $Rational(){};
    var self = $Rational = $klass($base, $super, 'Rational', $Rational);

    var def = self.$$proto, $scope = self.$$scope;

    return nil;
  })(self, $scope.get('Numeric'))
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/proc"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$raise']);
  return (function($base, $super) {
    function $Proc(){};
    var self = $Proc = $klass($base, $super, 'Proc', $Proc);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2;

    def.$$is_proc = true;

    def.$$is_lambda = false;

    Opal.defs(self, '$new', TMP_1 = function() {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      TMP_1.$$p = null;
      if (block !== false && block !== nil) {
        } else {
        self.$raise($scope.get('ArgumentError'), "tried to create a Proc object without a block")
      };
      return block;
    });

    def.$call = TMP_2 = function(args) {
      var self = this, $iter = TMP_2.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_2.$$p = null;
      
      if (block !== nil) {
        self.$$p = block;
      }

      var result;

      if (self.$$is_lambda) {
        result = self.apply(null, args);
      }
      else {
        result = Opal.yieldX(self, args);
      }

      if (result === $breaker) {
        return $breaker.$v;
      }

      return result;
    
    };

    Opal.defn(self, '$[]', def.$call);

    def.$to_proc = function() {
      var self = this;

      return self;
    };

    def['$lambda?'] = function() {
      var self = this;

      return !!self.$$is_lambda;
    };

    return (def.$arity = function() {
      var self = this;

      return self.length;
    }, nil) && 'arity';
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/method"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$attr_reader', '$class', '$arity', '$new', '$name']);
  (function($base, $super) {
    function $Method(){};
    var self = $Method = $klass($base, $super, 'Method', $Method);

    var def = self.$$proto, $scope = self.$$scope, TMP_1;

    def.method = def.receiver = def.owner = def.name = def.obj = nil;
    self.$attr_reader("owner", "receiver", "name");

    def.$initialize = function(receiver, method, name) {
      var self = this;

      self.receiver = receiver;
      self.owner = receiver.$class();
      self.name = name;
      return self.method = method;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$call = TMP_1 = function(args) {
      var self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 0);
      TMP_1.$$p = null;
      
      self.method.$$p = block;

      return self.method.apply(self.receiver, args);
    ;
    };

    Opal.defn(self, '$[]', def.$call);

    def.$unbind = function() {
      var self = this;

      return $scope.get('UnboundMethod').$new(self.owner, self.method, self.name);
    };

    def.$to_proc = function() {
      var self = this;

      return self.method;
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<Method: " + (self.obj.$class()) + "#" + (self.name) + "}>";
    }, nil) && 'inspect';
  })(self, null);
  return (function($base, $super) {
    function $UnboundMethod(){};
    var self = $UnboundMethod = $klass($base, $super, 'UnboundMethod', $UnboundMethod);

    var def = self.$$proto, $scope = self.$$scope;

    def.method = def.name = def.owner = nil;
    self.$attr_reader("owner", "name");

    def.$initialize = function(owner, method, name) {
      var self = this;

      self.owner = owner;
      self.method = method;
      return self.name = name;
    };

    def.$arity = function() {
      var self = this;

      return self.method.$arity();
    };

    def.$bind = function(object) {
      var self = this;

      return $scope.get('Method').$new(object, self.method, self.name);
    };

    return (def.$inspect = function() {
      var self = this;

      return "#<UnboundMethod: " + (self.owner.$name()) + "#" + (self.name) + ">";
    }, nil) && 'inspect';
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/range"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$require', '$include', '$attr_reader', '$<=>', '$raise', '$include?', '$<=', '$<', '$enum_for', '$succ', '$!', '$==', '$===', '$exclude_end?', '$eql?', '$begin', '$end', '$-', '$abs', '$to_i', '$inspect']);
  self.$require("corelib/enumerable");
  return (function($base, $super) {
    function $Range(){};
    var self = $Range = $klass($base, $super, 'Range', $Range);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_2, TMP_3;

    def.begin = def.exclude = def.end = nil;
    self.$include($scope.get('Enumerable'));

    def.$$is_range = true;

    self.$attr_reader("begin", "end");

    def.$initialize = function(first, last, exclude) {
      var $a, self = this;

      if (exclude == null) {
        exclude = false
      }
      if ((($a = first['$<=>'](last)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'))
      };
      self.begin = first;
      self.end = last;
      return self.exclude = exclude;
    };

    def['$=='] = function(other) {
      var self = this;

      
      if (!other.$$is_range) {
        return false;
      }

      return self.exclude === other.exclude &&
             self.begin   ==  other.begin &&
             self.end     ==  other.end;
    
    };

    def['$==='] = function(value) {
      var self = this;

      return self['$include?'](value);
    };

    def['$cover?'] = function(value) {
      var $a, $b, self = this;

      return (($a = self.begin['$<='](value)) ? ((function() {if ((($b = self.exclude) !== nil && (!$b.$$is_boolean || $b == true))) {
        return value['$<'](self.end)
        } else {
        return value['$<='](self.end)
      }; return nil; })()) : $a);
    };

    def.$each = TMP_1 = function() {
      var $a, $b, self = this, $iter = TMP_1.$$p, block = $iter || nil, current = nil, last = nil;

      TMP_1.$$p = null;
      if ((block !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      current = self.begin;
      last = self.end;
      while (current['$<'](last)) {
      if (Opal.yield1(block, current) === $breaker) return $breaker.$v;
      current = current.$succ();};
      if ((($a = ($b = self.exclude['$!'](), $b !== false && $b !== nil ?current['$=='](last) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (Opal.yield1(block, current) === $breaker) return $breaker.$v};
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, self = this;

      if ((($a = $scope.get('Range')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return false
      };
      return ($a = ($b = self.exclude['$==='](other['$exclude_end?']()), $b !== false && $b !== nil ?self.begin['$eql?'](other.$begin()) : $b), $a !== false && $a !== nil ?self.end['$eql?'](other.$end()) : $a);
    };

    def['$exclude_end?'] = function() {
      var self = this;

      return self.exclude;
    };

    Opal.defn(self, '$first', def.$begin);

    Opal.defn(self, '$include?', def['$cover?']);

    Opal.defn(self, '$last', def.$end);

    def.$max = TMP_2 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_2.$$p, $yield = $iter || nil;

      TMP_2.$$p = null;
      if (($yield !== nil)) {
        return Opal.find_super_dispatcher(self, 'max', TMP_2, $iter).apply(self, $zuper)
        } else {
        return self.exclude ? self.end - 1 : self.end;
      };
    };

    Opal.defn(self, '$member?', def['$cover?']);

    def.$min = TMP_3 = function() {var $zuper = $slice.call(arguments, 0);
      var self = this, $iter = TMP_3.$$p, $yield = $iter || nil;

      TMP_3.$$p = null;
      if (($yield !== nil)) {
        return Opal.find_super_dispatcher(self, 'min', TMP_3, $iter).apply(self, $zuper)
        } else {
        return self.begin
      };
    };

    Opal.defn(self, '$member?', def['$include?']);

    def.$size = function() {
      var $a, $b, self = this, _begin = nil, _end = nil, infinity = nil;

      _begin = self.begin;
      _end = self.end;
      if ((($a = self.exclude) !== nil && (!$a.$$is_boolean || $a == true))) {
        _end = _end['$-'](1)};
      if ((($a = ($b = $scope.get('Numeric')['$==='](_begin), $b !== false && $b !== nil ?$scope.get('Numeric')['$==='](_end) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        return nil
      };
      if (_end['$<'](_begin)) {
        return 0};
      infinity = (($scope.get('Float')).$$scope.get('INFINITY'));
      if ((($a = ((($b = infinity['$=='](_begin.$abs())) !== false && $b !== nil) ? $b : _end.$abs()['$=='](infinity))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return infinity};
      return ((Math.abs(_end - _begin) + 1)).$to_i();
    };

    def.$step = function(n) {
      var self = this;

      if (n == null) {
        n = 1
      }
      return self.$raise($scope.get('NotImplementedError'));
    };

    def.$to_s = function() {
      var self = this;

      return self.begin.$inspect() + (self.exclude ? '...' : '..') + self.end.$inspect();
    };

    return Opal.defn(self, '$inspect', def.$to_s);
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/time"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$require', '$include', '$kind_of?', '$to_i', '$coerce_to', '$between?', '$raise', '$new', '$compact', '$nil?', '$===', '$<=>', '$to_f', '$strftime', '$is_a?', '$zero?', '$wday', '$utc?', '$warn', '$year', '$mon', '$day', '$yday', '$hour', '$min', '$sec', '$rjust', '$ljust', '$zone', '$to_s', '$[]', '$cweek_cyear', '$month', '$isdst', '$private', '$<=', '$!', '$==', '$-', '$ceil', '$/', '$+']);
  self.$require("corelib/comparable");
  return (function($base, $super) {
    function $Time(){};
    var self = $Time = $klass($base, $super, 'Time', $Time);

    var def = self.$$proto, $scope = self.$$scope;

    def.tz_offset = nil;
    self.$include($scope.get('Comparable'));

    
    var days_of_week = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short_days   = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
        short_months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        long_months  = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  ;

    Opal.defs(self, '$at', function(seconds, frac) {
      var self = this;

      if (frac == null) {
        frac = 0
      }
      return new Date(seconds * 1000 + frac);
    });

    Opal.defs(self, '$new', function(year, month, day, hour, minute, second, utc_offset) {
      var self = this;

      
      switch (arguments.length) {
        case 1:
          return new Date(year, 0);

        case 2:
          return new Date(year, month - 1);

        case 3:
          return new Date(year, month - 1, day);

        case 4:
          return new Date(year, month - 1, day, hour);

        case 5:
          return new Date(year, month - 1, day, hour, minute);

        case 6:
          return new Date(year, month - 1, day, hour, minute, second);

        case 7:
          return new Date(year, month - 1, day, hour, minute, second);

        default:
          return new Date();
      }
    
    });

    Opal.defs(self, '$local', function(year, month, day, hour, minute, second, millisecond) {
      var $a, self = this;

      if (month == null) {
        month = nil
      }
      if (day == null) {
        day = nil
      }
      if (hour == null) {
        hour = nil
      }
      if (minute == null) {
        minute = nil
      }
      if (second == null) {
        second = nil
      }
      if (millisecond == null) {
        millisecond = nil
      }
      if ((($a = arguments.length === 10) !== nil && (!$a.$$is_boolean || $a == true))) {
        
        var args = $slice.call(arguments).reverse();

        second = args[9];
        minute = args[8];
        hour   = args[7];
        day    = args[6];
        month  = args[5];
        year   = args[4];
      };
      year = (function() {if ((($a = year['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return year.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(year, $scope.get('Integer'), "to_int")
      }; return nil; })();
      month = (function() {if ((($a = month['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return month.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = month) !== false && $a !== nil) ? $a : 1), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = month['$between?'](1, 12)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "month out of range: " + (month))
      };
      day = (function() {if ((($a = day['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return day.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = day) !== false && $a !== nil) ? $a : 1), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = day['$between?'](1, 31)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "day out of range: " + (day))
      };
      hour = (function() {if ((($a = hour['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return hour.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = hour) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = hour['$between?'](0, 24)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "hour out of range: " + (hour))
      };
      minute = (function() {if ((($a = minute['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return minute.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = minute) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = minute['$between?'](0, 59)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "minute out of range: " + (minute))
      };
      second = (function() {if ((($a = second['$kind_of?']($scope.get('String'))) !== nil && (!$a.$$is_boolean || $a == true))) {
        return second.$to_i()
        } else {
        return $scope.get('Opal').$coerce_to(((($a = second) !== false && $a !== nil) ? $a : 0), $scope.get('Integer'), "to_int")
      }; return nil; })();
      if ((($a = second['$between?'](0, 59)) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('ArgumentError'), "second out of range: " + (second))
      };
      return ($a = self).$new.apply($a, [].concat([year, month, day, hour, minute, second].$compact()));
    });

    Opal.defs(self, '$gm', function(year, month, day, hour, minute, second, utc_offset) {
      var $a, self = this;

      if ((($a = year['$nil?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "missing year (got nil)")};
      
      if (month > 12 || day > 31 || hour > 24 || minute > 59 || second > 59) {
        self.$raise($scope.get('ArgumentError'));
      }

      var date = new Date(Date.UTC(year, (month || 1) - 1, (day || 1), (hour || 0), (minute || 0), (second || 0)));
      date.tz_offset = 0
      return date;
    ;
    });

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$mktime = self.$$proto.$local;
      return self.$$proto.$utc = self.$$proto.$gm;
    })(self.$singleton_class());

    Opal.defs(self, '$now', function() {
      var self = this;

      return new Date();
    });

    def['$+'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        self.$raise($scope.get('TypeError'), "time + time?")};
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      
      var result           = new Date(self.getTime() + (other * 1000));
          result.tz_offset = self.tz_offset;

      return result;
    
    };

    def['$-'] = function(other) {
      var $a, self = this;

      if ((($a = $scope.get('Time')['$==='](other)) !== nil && (!$a.$$is_boolean || $a == true))) {
        return (self.getTime() - other.getTime()) / 1000};
      other = $scope.get('Opal').$coerce_to(other, $scope.get('Integer'), "to_int");
      
      var result           = new Date(self.getTime() - (other * 1000));
          result.tz_offset = self.tz_offset;

      return result;
    
    };

    def['$<=>'] = function(other) {
      var self = this;

      return self.$to_f()['$<=>'](other.$to_f());
    };

    def['$=='] = function(other) {
      var self = this;

      return self.$to_f() === other.$to_f();
    };

    def.$asctime = function() {
      var self = this;

      return self.$strftime("%a %b %e %H:%M:%S %Y");
    };

    Opal.defn(self, '$ctime', def.$asctime);

    def.$day = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCDate();
      }
      else {
        return self.getDate();
      }
    ;
    };

    def.$yday = function() {
      var self = this;

      
      // http://javascript.about.com/library/bldayyear.htm
      var onejan = new Date(self.getFullYear(), 0, 1);
      return Math.ceil((self - onejan) / 86400000);
    
    };

    def.$isdst = function() {
      var self = this;

      return self.$raise($scope.get('NotImplementedError'));
    };

    def['$eql?'] = function(other) {
      var $a, self = this;

      return ($a = other['$is_a?']($scope.get('Time')), $a !== false && $a !== nil ?(self['$<=>'](other))['$zero?']() : $a);
    };

    def['$friday?'] = function() {
      var self = this;

      return self.$wday() == 5;
    };

    def.$hour = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCHours();
      }
      else {
        return self.getHours();
      }
    ;
    };

    def.$inspect = function() {
      var $a, self = this;

      if ((($a = self['$utc?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
        return self.$strftime("%Y-%m-%d %H:%M:%S UTC")
        } else {
        return self.$strftime("%Y-%m-%d %H:%M:%S %z")
      };
    };

    Opal.defn(self, '$mday', def.$day);

    def.$min = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCMinutes();
      }
      else {
        return self.getMinutes();
      }
    ;
    };

    def.$mon = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCMonth() + 1;
      }
      else {
        return self.getMonth() + 1;
      }
    ;
    };

    def['$monday?'] = function() {
      var self = this;

      return self.$wday() == 1;
    };

    Opal.defn(self, '$month', def.$mon);

    def['$saturday?'] = function() {
      var self = this;

      return self.$wday() == 6;
    };

    def.$sec = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCSeconds();
      }
      else {
        return self.getSeconds();
      }
    ;
    };

    def.$usec = function() {
      var self = this;

      self.$warn("Microseconds are not supported");
      return 0;
    };

    def.$zone = function() {
      var self = this;

      
      var string = self.toString(),
          result;

      if (string.indexOf('(') == -1) {
        result = string.match(/[A-Z]{3,4}/)[0];
      }
      else {
        result = string.match(/\([^)]+\)/)[0].match(/[A-Z]/g).join('');
      }

      if (result == "GMT" && /(GMT\W*\d{4})/.test(string)) {
        return RegExp.$1;
      }
      else {
        return result;
      }
    
    };

    def.$getgm = function() {
      var self = this;

      
      var result           = new Date(self.getTime());
          result.tz_offset = 0;

      return result;
    
    };

    def['$gmt?'] = function() {
      var self = this;

      return self.tz_offset === 0;
    };

    def.$gmt_offset = function() {
      var self = this;

      return -self.getTimezoneOffset() * 60;
    };

    def.$strftime = function(format) {
      var self = this;

      
      return format.replace(/%([\-_#^0]*:{0,2})(\d+)?([EO]*)(.)/g, function(full, flags, width, _, conv) {
        var result = "",
            width  = parseInt(width),
            zero   = flags.indexOf('0') !== -1,
            pad    = flags.indexOf('-') === -1,
            blank  = flags.indexOf('_') !== -1,
            upcase = flags.indexOf('^') !== -1,
            invert = flags.indexOf('#') !== -1,
            colons = (flags.match(':') || []).length;

        if (zero && blank) {
          if (flags.indexOf('0') < flags.indexOf('_')) {
            zero = false;
          }
          else {
            blank = false;
          }
        }

        switch (conv) {
          case 'Y':
            result += self.$year();
            break;

          case 'C':
            zero    = !blank;
            result += Math.round(self.$year() / 100);
            break;

          case 'y':
            zero    = !blank;
            result += (self.$year() % 100);
            break;

          case 'm':
            zero    = !blank;
            result += self.$mon();
            break;

          case 'B':
            result += long_months[self.$mon() - 1];
            break;

          case 'b':
          case 'h':
            blank   = !zero;
            result += short_months[self.$mon() - 1];
            break;

          case 'd':
            zero    = !blank
            result += self.$day();
            break;

          case 'e':
            blank   = !zero
            result += self.$day();
            break;

          case 'j':
            result += self.$yday();
            break;

          case 'H':
            zero    = !blank;
            result += self.$hour();
            break;

          case 'k':
            blank   = !zero;
            result += self.$hour();
            break;

          case 'I':
            zero    = !blank;
            result += (self.$hour() % 12 || 12);
            break;

          case 'l':
            blank   = !zero;
            result += (self.$hour() % 12 || 12);
            break;

          case 'P':
            result += (self.$hour() >= 12 ? "pm" : "am");
            break;

          case 'p':
            result += (self.$hour() >= 12 ? "PM" : "AM");
            break;

          case 'M':
            zero    = !blank;
            result += self.$min();
            break;

          case 'S':
            zero    = !blank;
            result += self.$sec()
            break;

          case 'L':
            zero    = !blank;
            width   = isNaN(width) ? 3 : width;
            result += self.getMilliseconds();
            break;

          case 'N':
            width   = isNaN(width) ? 9 : width;
            result += (self.getMilliseconds().toString()).$rjust(3, "0");
            result  = (result).$ljust(width, "0");
            break;

          case 'z':
            var offset  = self.getTimezoneOffset(),
                hours   = Math.floor(Math.abs(offset) / 60),
                minutes = Math.abs(offset) % 60;

            result += offset < 0 ? "+" : "-";
            result += hours < 10 ? "0" : "";
            result += hours;

            if (colons > 0) {
              result += ":";
            }

            result += minutes < 10 ? "0" : "";
            result += minutes;

            if (colons > 1) {
              result += ":00";
            }

            break;

          case 'Z':
            result += self.$zone();
            break;

          case 'A':
            result += days_of_week[self.$wday()];
            break;

          case 'a':
            result += short_days[self.$wday()];
            break;

          case 'u':
            result += (self.$wday() + 1);
            break;

          case 'w':
            result += self.$wday();
            break;

          case 'V':
            result += self.$cweek_cyear()['$[]'](0).$to_s().$rjust(2, "0");
            break;

          case 'G':
            result += self.$cweek_cyear()['$[]'](1);
            break;

          case 'g':
            result += self.$cweek_cyear()['$[]'](1)['$[]']($range(-2, -1, false));
            break;

          case 's':
            result += self.$to_i();
            break;

          case 'n':
            result += "\n";
            break;

          case 't':
            result += "\t";
            break;

          case '%':
            result += "%";
            break;

          case 'c':
            result += self.$strftime("%a %b %e %T %Y");
            break;

          case 'D':
          case 'x':
            result += self.$strftime("%m/%d/%y");
            break;

          case 'F':
            result += self.$strftime("%Y-%m-%d");
            break;

          case 'v':
            result += self.$strftime("%e-%^b-%4Y");
            break;

          case 'r':
            result += self.$strftime("%I:%M:%S %p");
            break;

          case 'R':
            result += self.$strftime("%H:%M");
            break;

          case 'T':
          case 'X':
            result += self.$strftime("%H:%M:%S");
            break;

          default:
            return full;
        }

        if (upcase) {
          result = result.toUpperCase();
        }

        if (invert) {
          result = result.replace(/[A-Z]/, function(c) { c.toLowerCase() }).
                          replace(/[a-z]/, function(c) { c.toUpperCase() });
        }

        if (pad && (zero || blank)) {
          result = (result).$rjust(isNaN(width) ? 2 : width, blank ? " " : "0");
        }

        return result;
      });
    
    };

    def['$sunday?'] = function() {
      var self = this;

      return self.$wday() == 0;
    };

    def['$thursday?'] = function() {
      var self = this;

      return self.$wday() == 4;
    };

    def.$to_a = function() {
      var self = this;

      return [self.$sec(), self.$min(), self.$hour(), self.$day(), self.$month(), self.$year(), self.$wday(), self.$yday(), self.$isdst(), self.$zone()];
    };

    def.$to_f = function() {
      var self = this;

      return self.getTime() / 1000;
    };

    def.$to_i = function() {
      var self = this;

      return parseInt(self.getTime() / 1000);
    };

    Opal.defn(self, '$to_s', def.$inspect);

    def['$tuesday?'] = function() {
      var self = this;

      return self.$wday() == 2;
    };

    Opal.defn(self, '$utc?', def['$gmt?']);

    Opal.defn(self, '$utc_offset', def.$gmt_offset);

    def.$wday = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCDay();
      }
      else {
        return self.getDay();
      }
    ;
    };

    def['$wednesday?'] = function() {
      var self = this;

      return self.$wday() == 3;
    };

    def.$year = function() {
      var self = this;

      
      if (self.tz_offset === 0) {
        return self.getUTCFullYear();
      }
      else {
        return self.getFullYear();
      }
    ;
    };

    self.$private("cweek_cyear");

    return (def.$cweek_cyear = function() {
      var $a, $b, self = this, jan01 = nil, jan01_wday = nil, first_monday = nil, year = nil, offset = nil, week = nil, dec31 = nil, dec31_wday = nil;

      jan01 = $scope.get('Time').$new(self.$year(), 1, 1);
      jan01_wday = jan01.$wday();
      first_monday = 0;
      year = self.$year();
      if ((($a = (($b = jan01_wday['$<='](4)) ? jan01_wday['$=='](0)['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
        offset = jan01_wday['$-'](1)
        } else {
        offset = jan01_wday['$-'](7)['$-'](1);
        if (offset['$=='](-8)) {
          offset = -1};
      };
      week = ((self.$yday()['$+'](offset))['$/'](7.0)).$ceil();
      if (week['$<='](0)) {
        return $scope.get('Time').$new(self.$year()['$-'](1), 12, 31).$cweek_cyear()
      } else if (week['$=='](53)) {
        dec31 = $scope.get('Time').$new(self.$year(), 12, 31);
        dec31_wday = dec31.$wday();
        if ((($a = (($b = dec31_wday['$<='](3)) ? dec31_wday['$=='](0)['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          week = 1;
          year = year['$+'](1);};};
      return [week, year];
    }, nil) && 'cweek_cyear';
  })(self, null);
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/struct"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$==', '$[]', '$upcase', '$const_set', '$new', '$unshift', '$each', '$define_struct_attribute', '$instance_eval', '$to_proc', '$raise', '$<<', '$members', '$attr_accessor', '$include', '$each_with_index', '$instance_variable_set', '$class', '$===', '$>=', '$size', '$include?', '$to_sym', '$instance_variable_get', '$enum_for', '$hash', '$all?', '$length', '$map', '$+', '$join', '$inspect', '$each_pair']);
  return (function($base, $super) {
    function $Struct(){};
    var self = $Struct = $klass($base, $super, 'Struct', $Struct);

    var def = self.$$proto, $scope = self.$$scope, TMP_1, TMP_6, TMP_8;

    Opal.defs(self, '$new', TMP_1 = function(name, args) {var $zuper = $slice.call(arguments, 0);
      var $a, $b, $c, TMP_2, self = this, $iter = TMP_1.$$p, block = $iter || nil;

      args = $slice.call(arguments, 1);
      TMP_1.$$p = null;
      if (self['$==']($scope.get('Struct'))) {
        } else {
        return Opal.find_super_dispatcher(self, 'new', TMP_1, $iter, $Struct).apply(self, $zuper)
      };
      if (name['$[]'](0)['$=='](name['$[]'](0).$upcase())) {
        return $scope.get('Struct').$const_set(name, ($a = self).$new.apply($a, [].concat(args)))
        } else {
        args.$unshift(name);
        return ($b = ($c = $scope.get('Class')).$new, $b.$$p = (TMP_2 = function(){var self = TMP_2.$$s || this, $a, $b, TMP_3, $c;

        ($a = ($b = args).$each, $a.$$p = (TMP_3 = function(arg){var self = TMP_3.$$s || this;
if (arg == null) arg = nil;
          return self.$define_struct_attribute(arg)}, TMP_3.$$s = self, TMP_3), $a).call($b);
          if (block !== false && block !== nil) {
            return ($a = ($c = self).$instance_eval, $a.$$p = block.$to_proc(), $a).call($c)
            } else {
            return nil
          };}, TMP_2.$$s = self, TMP_2), $b).call($c, self);
      };
    });

    Opal.defs(self, '$define_struct_attribute', function(name) {
      var self = this;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "you cannot define attributes to the Struct class")};
      self.$members()['$<<'](name);
      return self.$attr_accessor(name);
    });

    Opal.defs(self, '$members', function() {
      var $a, self = this;
      if (self.members == null) self.members = nil;

      if (self['$==']($scope.get('Struct'))) {
        self.$raise($scope.get('ArgumentError'), "the Struct class has no members")};
      return ((($a = self.members) !== false && $a !== nil) ? $a : self.members = []);
    });

    Opal.defs(self, '$inherited', function(klass) {
      var $a, $b, TMP_4, self = this, members = nil;
      if (self.members == null) self.members = nil;

      if (self['$==']($scope.get('Struct'))) {
        return nil};
      members = self.members;
      return ($a = ($b = klass).$instance_eval, $a.$$p = (TMP_4 = function(){var self = TMP_4.$$s || this;

      return self.members = members}, TMP_4.$$s = self, TMP_4), $a).call($b);
    });

    (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      return self.$$proto['$[]'] = self.$$proto.$new
    })(self.$singleton_class());

    self.$include($scope.get('Enumerable'));

    def.$initialize = function(args) {
      var $a, $b, TMP_5, self = this;

      args = $slice.call(arguments, 0);
      return ($a = ($b = self.$members()).$each_with_index, $a.$$p = (TMP_5 = function(name, index){var self = TMP_5.$$s || this;
if (name == null) name = nil;if (index == null) index = nil;
      return self.$instance_variable_set("@" + (name), args['$[]'](index))}, TMP_5.$$s = self, TMP_5), $a).call($b);
    };

    def.$members = function() {
      var self = this;

      return self.$class().$members();
    };

    def['$[]'] = function(name) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_get("@" + (name));
    };

    def['$[]='] = function(name, value) {
      var $a, self = this;

      if ((($a = $scope.get('Integer')['$==='](name)) !== nil && (!$a.$$is_boolean || $a == true))) {
        if (name['$>='](self.$members().$size())) {
          self.$raise($scope.get('IndexError'), "offset " + (name) + " too large for struct(size:" + (self.$members().$size()) + ")")};
        name = self.$members()['$[]'](name);
      } else if ((($a = self.$members()['$include?'](name.$to_sym())) !== nil && (!$a.$$is_boolean || $a == true))) {
        } else {
        self.$raise($scope.get('NameError'), "no member '" + (name) + "' in struct")
      };
      return self.$instance_variable_set("@" + (name), value);
    };

    def.$each = TMP_6 = function() {
      var $a, $b, TMP_7, self = this, $iter = TMP_6.$$p, $yield = $iter || nil;

      TMP_6.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each")
      };
      ($a = ($b = self.$members()).$each, $a.$$p = (TMP_7 = function(name){var self = TMP_7.$$s || this, $a;
if (name == null) name = nil;
      return $a = Opal.yield1($yield, self['$[]'](name)), $a === $breaker ? $a : $a}, TMP_7.$$s = self, TMP_7), $a).call($b);
      return self;
    };

    def.$each_pair = TMP_8 = function() {
      var $a, $b, TMP_9, self = this, $iter = TMP_8.$$p, $yield = $iter || nil;

      TMP_8.$$p = null;
      if (($yield !== nil)) {
        } else {
        return self.$enum_for("each_pair")
      };
      ($a = ($b = self.$members()).$each, $a.$$p = (TMP_9 = function(name){var self = TMP_9.$$s || this, $a;
if (name == null) name = nil;
      return $a = Opal.yieldX($yield, [name, self['$[]'](name)]), $a === $breaker ? $a : $a}, TMP_9.$$s = self, TMP_9), $a).call($b);
      return self;
    };

    def['$eql?'] = function(other) {
      var $a, $b, $c, TMP_10, self = this;

      return ((($a = self.$hash()['$=='](other.$hash())) !== false && $a !== nil) ? $a : ($b = ($c = other.$each_with_index())['$all?'], $b.$$p = (TMP_10 = function(object, index){var self = TMP_10.$$s || this;
if (object == null) object = nil;if (index == null) index = nil;
      return self['$[]'](self.$members()['$[]'](index))['$=='](object)}, TMP_10.$$s = self, TMP_10), $b).call($c));
    };

    def.$length = function() {
      var self = this;

      return self.$members().$length();
    };

    Opal.defn(self, '$size', def.$length);

    def.$to_a = function() {
      var $a, $b, TMP_11, self = this;

      return ($a = ($b = self.$members()).$map, $a.$$p = (TMP_11 = function(name){var self = TMP_11.$$s || this;
if (name == null) name = nil;
      return self['$[]'](name)}, TMP_11.$$s = self, TMP_11), $a).call($b);
    };

    Opal.defn(self, '$values', def.$to_a);

    def.$inspect = function() {
      var $a, $b, TMP_12, self = this, result = nil;

      result = "#<struct ";
      if (self.$class()['$==']($scope.get('Struct'))) {
        result = result['$+']("" + (self.$class()) + " ")};
      result = result['$+'](($a = ($b = self.$each_pair()).$map, $a.$$p = (TMP_12 = function(name, value){var self = TMP_12.$$s || this;
if (name == null) name = nil;if (value == null) value = nil;
      return "" + (name) + "=" + (value.$inspect())}, TMP_12.$$s = self, TMP_12), $a).call($b).$join(", "));
      result = result['$+'](">");
      return result;
    };

    return Opal.defn(self, '$to_s', def.$inspect);
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/io"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var $a, $b, self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $module = Opal.module, $gvars = Opal.gvars;
  if ($gvars.stdout == null) $gvars.stdout = nil;
  if ($gvars.stderr == null) $gvars.stderr = nil;

  Opal.add_stubs(['$attr_accessor', '$size', '$write', '$join', '$map', '$String', '$empty?', '$concat', '$chomp', '$getbyte', '$getc', '$raise', '$new', '$write_proc=', '$extend']);
  (function($base, $super) {
    function $IO(){};
    var self = $IO = $klass($base, $super, 'IO', $IO);

    var def = self.$$proto, $scope = self.$$scope;

    def.tty = def.closed = nil;
    Opal.cdecl($scope, 'SEEK_SET', 0);

    Opal.cdecl($scope, 'SEEK_CUR', 1);

    Opal.cdecl($scope, 'SEEK_END', 2);

    def['$tty?'] = function() {
      var self = this;

      return self.tty;
    };

    def['$closed?'] = function() {
      var self = this;

      return self.closed;
    };

    self.$attr_accessor("write_proc");

    def.$write = function(string) {
      var self = this;

      self.write_proc(string);
      return string.$size();
    };

    self.$attr_accessor("sync");

    (function($base) {
      var self = $module($base, 'Writable');

      var def = self.$$proto, $scope = self.$$scope;

      Opal.defn(self, '$<<', function(string) {
        var self = this;

        self.$write(string);
        return self;
      });

      Opal.defn(self, '$print', function(args) {
        var $a, $b, TMP_1, self = this;
        if ($gvars[","] == null) $gvars[","] = nil;

        args = $slice.call(arguments, 0);
        self.$write(($a = ($b = args).$map, $a.$$p = (TMP_1 = function(arg){var self = TMP_1.$$s || this;
if (arg == null) arg = nil;
        return self.$String(arg)}, TMP_1.$$s = self, TMP_1), $a).call($b).$join($gvars[","]));
        return nil;
      });

      Opal.defn(self, '$puts', function(args) {
        var $a, $b, TMP_2, self = this, newline = nil;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        args = $slice.call(arguments, 0);
        newline = $gvars["/"];
        if ((($a = args['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$write($gvars["/"])
          } else {
          self.$write(($a = ($b = args).$map, $a.$$p = (TMP_2 = function(arg){var self = TMP_2.$$s || this;
if (arg == null) arg = nil;
          return self.$String(arg).$chomp()}, TMP_2.$$s = self, TMP_2), $a).call($b).$concat([nil]).$join(newline))
        };
        return nil;
      });
    })(self);

    return (function($base) {
      var self = $module($base, 'Readable');

      var def = self.$$proto, $scope = self.$$scope;

      Opal.defn(self, '$readbyte', function() {
        var self = this;

        return self.$getbyte();
      });

      Opal.defn(self, '$readchar', function() {
        var self = this;

        return self.$getc();
      });

      Opal.defn(self, '$readline', function(sep) {
        var self = this;
        if ($gvars["/"] == null) $gvars["/"] = nil;

        if (sep == null) {
          sep = $gvars["/"]
        }
        return self.$raise($scope.get('NotImplementedError'));
      });

      Opal.defn(self, '$readpartial', function(integer, outbuf) {
        var self = this;

        if (outbuf == null) {
          outbuf = nil
        }
        return self.$raise($scope.get('NotImplementedError'));
      });
    })(self);
  })(self, null);
  Opal.cdecl($scope, 'STDERR', $gvars.stderr = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDIN', $gvars.stdin = $scope.get('IO').$new());
  Opal.cdecl($scope, 'STDOUT', $gvars.stdout = $scope.get('IO').$new());
  (($a = [typeof(process) === 'object' ? function(s){process.stdout.write(s)} : function(s){console.log(s)}]), $b = $gvars.stdout, $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  (($a = [typeof(process) === 'object' ? function(s){process.stderr.write(s)} : function(s){console.warn(s)}]), $b = $gvars.stderr, $b['$write_proc='].apply($b, $a), $a[$a.length-1]);
  $gvars.stdout.$extend((($scope.get('IO')).$$scope.get('Writable')));
  return $gvars.stderr.$extend((($scope.get('IO')).$$scope.get('Writable')));
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/main"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$include']);
  Opal.defs(self, '$to_s', function() {
    var self = this;

    return "main";
  });
  return (Opal.defs(self, '$include', function(mod) {
    var self = this;

    return $scope.get('Object').$include(mod);
  }), nil) && 'include';
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/variables"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $gvars = Opal.gvars, $hash2 = Opal.hash2;

  Opal.add_stubs(['$new']);
  $gvars["&"] = $gvars["~"] = $gvars["`"] = $gvars["'"] = nil;
  $gvars.LOADED_FEATURES = $gvars["\""] = Opal.loaded_features;
  $gvars.LOAD_PATH = $gvars[":"] = [];
  $gvars["/"] = "\n";
  $gvars[","] = nil;
  Opal.cdecl($scope, 'ARGV', []);
  Opal.cdecl($scope, 'ARGF', $scope.get('Object').$new());
  Opal.cdecl($scope, 'ENV', $hash2([], {}));
  $gvars.VERBOSE = false;
  $gvars.DEBUG = false;
  $gvars.SAFE = 0;
  Opal.cdecl($scope, 'RUBY_PLATFORM', "opal");
  Opal.cdecl($scope, 'RUBY_ENGINE', "opal");
  Opal.cdecl($scope, 'RUBY_VERSION', "2.1.1");
  Opal.cdecl($scope, 'RUBY_ENGINE_VERSION', "0.6.1");
  return Opal.cdecl($scope, 'RUBY_RELEASE_DATE', "2014-04-15");
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/dir"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass;

  Opal.add_stubs(['$[]']);
  return (function($base, $super) {
    function $Dir(){};
    var self = $Dir = $klass($base, $super, 'Dir', $Dir);

    var def = self.$$proto, $scope = self.$$scope;

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$chdir = TMP_1 = function(dir) {
        var $a, self = this, $iter = TMP_1.$$p, $yield = $iter || nil, prev_cwd = nil;

        TMP_1.$$p = null;
        try {
        prev_cwd = Opal.current_dir;
        Opal.current_dir = dir;
        return $a = Opal.yieldX($yield, []), $a === $breaker ? $a : $a;
        } finally {
        Opal.current_dir = prev_cwd;
        };
      };
      self.$$proto.$pwd = function() {
        var self = this;

        return Opal.current_dir || '.';
      };
      self.$$proto.$getwd = self.$$proto.$pwd;
      return (self.$$proto.$home = function() {
        var $a, self = this;

        return ((($a = $scope.get('ENV')['$[]']("HOME")) !== false && $a !== nil) ? $a : ".");
      }, nil) && 'home';
    })(self.$singleton_class())
  })(self, null)
};

/* Generated by Opal 0.7.1 */
Opal.modules["corelib/file"] = function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $klass = Opal.klass, $range = Opal.range;

  Opal.add_stubs(['$join', '$compact', '$split', '$==', '$first', '$[]=', '$home', '$each', '$pop', '$<<', '$[]', '$gsub', '$find', '$=~']);
  return (function($base, $super) {
    function $File(){};
    var self = $File = $klass($base, $super, 'File', $File);

    var def = self.$$proto, $scope = self.$$scope;

    Opal.cdecl($scope, 'Separator', Opal.cdecl($scope, 'SEPARATOR', "/"));

    Opal.cdecl($scope, 'ALT_SEPARATOR', nil);

    Opal.cdecl($scope, 'PATH_SEPARATOR', ":");

    return (function(self) {
      var $scope = self.$$scope, def = self.$$proto;

      self.$$proto.$expand_path = function(path, basedir) {
        var $a, $b, TMP_1, self = this, parts = nil, new_parts = nil;

        if (basedir == null) {
          basedir = nil
        }
        path = [basedir, path].$compact().$join($scope.get('SEPARATOR'));
        parts = path.$split($scope.get('SEPARATOR'));
        new_parts = [];
        if (parts.$first()['$==']("~")) {
          parts['$[]='](0, $scope.get('Dir').$home())};
        ($a = ($b = parts).$each, $a.$$p = (TMP_1 = function(part){var self = TMP_1.$$s || this;
if (part == null) part = nil;
        if (part['$==']("..")) {
            return new_parts.$pop()
            } else {
            return new_parts['$<<'](part)
          }}, TMP_1.$$s = self, TMP_1), $a).call($b);
        return new_parts.$join($scope.get('SEPARATOR'));
      };
      self.$$proto.$dirname = function(path) {
        var self = this;

        return self.$split(path)['$[]']($range(0, -2, false));
      };
      self.$$proto.$basename = function(path) {
        var self = this;

        return self.$split(path)['$[]'](-1);
      };
      self.$$proto['$exist?'] = function(path) {
        var self = this;

        return Opal.modules[path] != null;
      };
      self.$$proto['$exists?'] = self.$$proto['$exist?'];
      self.$$proto['$directory?'] = function(path) {
        var $a, $b, TMP_2, self = this, files = nil, file = nil;

        files = [];
        
        for (var key in Opal.modules) {
          files.push(key)
        }
      ;
        path = path.$gsub((new RegExp("(^." + $scope.get('SEPARATOR') + "+|" + $scope.get('SEPARATOR') + "+$)")));
        file = ($a = ($b = files).$find, $a.$$p = (TMP_2 = function(file){var self = TMP_2.$$s || this;
if (file == null) file = nil;
        return file['$=~']((new RegExp("^" + path)))}, TMP_2.$$s = self, TMP_2), $a).call($b);
        return file;
      };
      self.$$proto.$join = function(paths) {
        var self = this;

        paths = $slice.call(arguments, 0);
        return paths.$join($scope.get('SEPARATOR')).$gsub((new RegExp("" + $scope.get('SEPARATOR') + "+")), $scope.get('SEPARATOR'));
      };
      return (self.$$proto.$split = function(path) {
        var self = this;

        return path.$split($scope.get('SEPARATOR'));
      }, nil) && 'split';
    })(self.$singleton_class());
  })(self, $scope.get('IO'))
};

/* Generated by Opal 0.7.1 */
(function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$require']);
  self.$require("corelib/runtime");
  self.$require("corelib/helpers");
  self.$require("corelib/module");
  self.$require("corelib/class");
  self.$require("corelib/basic_object");
  self.$require("corelib/kernel");
  self.$require("corelib/nil_class");
  self.$require("corelib/boolean");
  self.$require("corelib/error");
  self.$require("corelib/regexp");
  self.$require("corelib/comparable");
  self.$require("corelib/enumerable");
  self.$require("corelib/enumerator");
  self.$require("corelib/array");
  self.$require("corelib/array/inheritance");
  self.$require("corelib/hash");
  self.$require("corelib/string");
  self.$require("corelib/string/inheritance");
  self.$require("corelib/match_data");
  self.$require("corelib/numeric");
  self.$require("corelib/complex");
  self.$require("corelib/rational");
  self.$require("corelib/proc");
  self.$require("corelib/method");
  self.$require("corelib/range");
  self.$require("corelib/time");
  self.$require("corelib/struct");
  self.$require("corelib/io");
  self.$require("corelib/main");
  self.$require("corelib/variables");
  self.$require("corelib/dir");
  return self.$require("corelib/file");
})(Opal);

/* Generated by Opal 0.7.1 */
(function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice, $module = Opal.module, $klass = Opal.klass, $hash2 = Opal.hash2, $range = Opal.range;

  Opal.add_stubs(['$attr_accessor', '$new', '$[]', '$addChild', '$<<', '$shape', '$plot=', '$graph=', '$add', '$>=', '$each', '$call', '$method', '$to_Y', '$+', '$*', '$-', '$<', '$[]=', '$empty?', '$xylim', '$zoom', '$syncedChildren', '$synced?', '$select', '$include?', '$min', '$map', '$==', '$max', '$/', '$update', '$===', '$id', '$!', '$each_key', '$showZoom', '$updateZoom', '$>', '$to_s', '$length', '$initStep', '$seq', '$dim', '$to_X', '$mean', '$maxPdf', '$stdDev', '$sample', '$pdf', '$type', '$map!', '$step', '$y', '$to_f', '$abs', '$set', '$initDistrib', '$setAsTransfOf', '$regular?', '$bounds', '$initXYLim', '$adjust', '$drawCont', '$drawDisc', '$**', '$init', '$draw', '$distrib', '$each_with_index', '$floor', '$quantize', '$updateBounds', '$reset', '$drawCurve', '$<=', '$index', '$inject', '$acceptLevelNext', '$dup', '$counts', '$density', '$partBounds', '$graph', '$syncTo', '$setDistrib', '$style', '$attachCurve', '$attachSummary', '$marg', '$attachExpAxis', '$setAlpha', '$setStatMode', '$isModeHidden?', '$setTransf', '$setMLevel', '$setN', '$active=', '$setCurHist', '$setTCL', '$updateTCL', '$updateVisible', '$style=', '$variance', '$setDistribAs', '$setDistribAsTransf', '$xy', '$setNbSim', '$initTransfList', '$name', '$setTransfDistrib', '$-@', '$transfMode', '$quantile', '$applyTransfByIndex', '$seMean_transf_by_index', '$applyTransfByValue', '$allowLevelChange', '$updateHistAEP', '$aep', '$hideAll', '$drawSummary', '$incCptIC', '$drawMean', '$drawSD', '$animMode', '$seMean_transf', '$cptICTot=', '$cptICTot', '$playNextAfter', '$addXY', '$transitionInitHist', '$transitionInitPts', '$transitionInitRects', '$transitionInitTime', '$transitionDrawPts', '$transitionFallPts', '$transitionHistPtsAndRects', '$transitionInitExpRects', '$transitionExpPtsAndRects', '$transitionDrawRectsHidden', '$transitionHistPtsAndRectsHidden', '$transitionInitTransf', '$transitionInitPtsTransf', '$transitionPtsTransf', '$transitionDrawIC', '$playLongDensityWithTransfHidden', '$playLongDensityForIC', '$playLongDensityWithTransf', '$playLongDensityBasicHidden', '$playLongDensityBasic', '$join', '$power', '$p', '$qbounds', '$to_a', '$prepare', '$keys', '$sort']);
  return (function($base) {
    var self = $module($base, 'CqlsAEP');

    var def = self.$$proto, $scope = self.$$scope;

    (function($base, $super) {
      function $Plot(){};
      var self = $Plot = $klass($base, $super, 'Plot', $Plot);

      var def = self.$$proto, $scope = self.$$scope;

      def.dim = def.frame = def.style = def.axisShape = def.updateCalls = def.graph = def.parent = nil;
      self.$attr_accessor("parent", "frame", "style", "graph", "dim");

      def.$initialize = function(dim, style) {
        var $a, self = this;

        if (dim == null) {
          dim = $hash2(["x", "y", "w", "h"], {"x": 0, "y": 0, "w": cqlsAEP.i.dim.w, "h": cqlsAEP.i.dim.h})
        }
        if (style == null) {
          style = $hash2(["bg"], {"bg": "#88FF88"})
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1];
        self.parent = new createjs.Container();
        self.frame = new createjs.Shape();
        self.graph = (($scope.get('CqlsAEP')).$$scope.get('Graph')).$new(self.dim);
        self.updateCalls = [];
        self.frame.graphics.beginLinearGradientFill(["#FFF",self.style['$[]']("bg")], [0, 1], 0, self.dim['$[]']("y")+20, 0, self.dim['$[]']("y")+self.dim['$[]']("h")+20).drawRect(self.dim['$[]']("x"),self.dim['$[]']("y"),self.dim['$[]']("w"),self.dim['$[]']("h"));
        self.$addChild(self.frame);
        self.axisShape = new createjs.Shape();
        return self.$addChild(self.axisShape, [self, "drawAxis"]);
      };

      def.$addChild = function(child, updateCall, pos) {
        var $a, $b, self = this, shape = nil;

        if (updateCall == null) {
          updateCall = nil
        }
        if (pos == null) {
          pos = -1
        }
        shape = child;
        if (updateCall !== false && updateCall !== nil) {
          self.updateCalls['$<<']([child, updateCall])};
        if ((($a = child.shape == null) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          shape = child.$shape();
          (($a = [self]), $b = child, $b['$plot='].apply($b, $a), $a[$a.length-1]);
          (($a = [self.graph]), $b = child, $b['$graph='].apply($b, $a), $a[$a.length-1]);
          self.graph.$add(child);
        };
        if (pos['$>='](0)) {
          return self.parent.addChildAt(shape,pos);
          } else {
          return self.parent.addChild(shape);
        };
      };

      def.$update = function() {
        var $a, $b, TMP_1, self = this;

        return ($a = ($b = self.updateCalls).$each, $a.$$p = (TMP_1 = function(k, v){var self = TMP_1.$$s || this, $a, args = nil;
if (k == null) k = nil;if (v == null) v = nil;
        args = v['$[]'](2);
          if (args !== false && args !== nil) {
            } else {
            args = []
          };
          return ($a = v['$[]'](0).$method(v['$[]'](1))).$call.apply($a, [].concat(args));}, TMP_1.$$s = self, TMP_1), $a).call($b);
      };

      return (def.$drawAxis = function() {
        var self = this;

        return self.axisShape.graphics.ss(3,2).s("#000").mt(self.dim['$[]']("x"),self.graph.$to_Y(0.0)).lt(self.dim['$[]']("x")['$+'](self.dim['$[]']("w")),self.graph.$to_Y(0.0)).es();
      }, nil) && 'drawAxis';
    })(self, null);

    (function($base, $super) {
      function $Graph(){};
      var self = $Graph = $klass($base, $super, 'Graph', $Graph);

      var def = self.$$proto, $scope = self.$$scope;

      def.marg = def.dim = def.xylim0 = def.list = def.synced = def.xylim = def.zoom = def.tr = def.syncedChildren = def.active = def.zoomShapes = nil;
      self.$attr_accessor("xylim", "dim", "active", "syncedChildren", "zoom", "marg");

      Opal.defs($scope.get('Graph'), '$adjust', function(inter, more) {
        var self = this, l = nil;

        if (more == null) {
          more = 0
        }
        l = (inter['$[]'](1)['$-'](inter['$[]'](0)))['$*'](more);
        return [inter['$[]'](0)['$-'](more), inter['$[]'](1)['$+'](more)];
      });

      def.$initialize = function(dim, xlim, ylim, style) {
        var $a, self = this;

        if (xlim == null) {
          xlim = []
        }
        if (ylim == null) {
          ylim = []
        }
        if (style == null) {
          style = nil
        }
        $a = [dim, style], self.dim = $a[0], self.style = $a[1];
        self.marg = $hash2(["l", "r", "t", "b"], {"l": 0.1, "r": 0.1, "t": 0.2, "b": 0.1});
        if (self.marg['$[]']("l")['$<'](1)) {
          self.marg['$[]=']("l", self.dim['$[]']("w")['$*'](self.marg['$[]']("l")))};
        if (self.marg['$[]']("r")['$<'](1)) {
          self.marg['$[]=']("r", self.dim['$[]']("w")['$*'](self.marg['$[]']("r")))};
        if (self.marg['$[]']("t")['$<'](1)) {
          self.marg['$[]=']("t", self.dim['$[]']("h")['$*'](self.marg['$[]']("t")))};
        if (self.marg['$[]']("b")['$<'](1)) {
          self.marg['$[]=']("b", self.dim['$[]']("h")['$*'](self.marg['$[]']("b")))};
        self.xylim0 = $hash2(["x", "y"], {"x": xlim, "y": ylim});
        $a = [[], []], self.list = $a[0], self.active = $a[1];
        if ((($a = self.xylim0['$[]']("x")['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.list['$<<'](self.xylim0)
        };
        self.xylim = $hash2(["x", "y"], {"x": [], "y": []});
        self.tr = $hash2([], {});
        self.zoom = $hash2(["x0", "x1", "y0", "y1", "active"], {"x0": 0.0, "x1": 0.0, "y0": 0.0, "y1": 0.0, "active": false});
        return self.syncedChildren = [];
      };

      def.$syncTo = function(graph) {
        var self = this;

        self.xylim = graph.$xylim();
        self.zoom = graph.$zoom();
        graph.$syncedChildren()['$<<'](self);
        return self.synced = true;
      };

      def['$synced?'] = function() {
        var self = this;

        return self.synced;
      };

      def.$update = function(active) {
        var $a, $b, TMP_2, $c, TMP_3, $d, TMP_4, $e, TMP_5, $f, TMP_6, $g, TMP_7, self = this, list = nil;

        if (active == null) {
          active = self.active
        }
        if ((($a = self['$synced?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          list = ($a = ($b = self.list).$select, $a.$$p = (TMP_2 = function(e){var self = TMP_2.$$s || this, $a;
if (e == null) e = nil;
          return ((($a = active['$empty?']()) !== false && $a !== nil) ? $a : (active['$include?'](e['$[]'](1))))}, TMP_2.$$s = self, TMP_2), $a).call($b);
          self.xylim['$[]']("x")['$[]='](0, ($a = ($c = list).$map, $a.$$p = (TMP_3 = function(e){var self = TMP_3.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](0);}, TMP_3.$$s = self, TMP_3), $a).call($c).$min());
          self.xylim['$[]']("x")['$[]='](1, ($a = ($d = list).$map, $a.$$p = (TMP_4 = function(e){var self = TMP_4.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("x")['$[]'](1);}, TMP_4.$$s = self, TMP_4), $a).call($d).$max());
          self.xylim['$[]']("y")['$[]='](0, ($a = ($e = list).$map, $a.$$p = (TMP_5 = function(e){var self = TMP_5.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](0);}, TMP_5.$$s = self, TMP_5), $a).call($e).$min());
          self.xylim['$[]']("y")['$[]='](1, ($a = ($f = list).$map, $a.$$p = (TMP_6 = function(e){var self = TMP_6.$$s || this, e2 = nil;
if (e == null) e = nil;
          e2 = ((function() {if (e['$[]'](0)['$==']("element")) {
              return e['$[]'](2).$xylim()
              } else {
              return e['$[]'](2)
            }; return nil; })());
            return e2['$[]']("y")['$[]'](1);}, TMP_6.$$s = self, TMP_6), $a).call($f).$max());
        };
        $a = [(self.xylim['$[]']("x")['$[]'](1)['$+'](self.zoom['$[]']("x1"))['$-'](self.xylim['$[]']("x")['$[]'](0))['$-'](self.zoom['$[]']("x0")))['$/']((self.dim['$[]']("w")['$-'](self.marg['$[]']("l"))['$-'](self.marg['$[]']("r")))), (self.xylim['$[]']("y")['$[]'](0)['$+'](self.zoom['$[]']("y0"))['$-'](self.xylim['$[]']("y")['$[]'](1))['$-'](self.zoom['$[]']("y1")))['$/']((self.dim['$[]']("h")['$-'](self.marg['$[]']("t"))['$-'](self.marg['$[]']("b"))))], self.tr['$[]=']("ax", $a[0]), self.tr['$[]=']("ay", $a[1]);
        $a = [self.xylim['$[]']("x")['$[]'](0)['$+'](self.zoom['$[]']("x0"))['$-'](self.tr['$[]']("ax")['$*']((self.dim['$[]']("x")['$+'](self.marg['$[]']("l"))))), self.xylim['$[]']("y")['$[]'](1)['$+'](self.zoom['$[]']("y1"))['$-'](self.tr['$[]']("ay")['$*']((self.dim['$[]']("y")['$+'](self.marg['$[]']("t")))))], self.tr['$[]=']("bx", $a[0]), self.tr['$[]=']("by", $a[1]);
        if ((($a = self.syncedChildren['$empty?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil
          } else {
          return ($a = ($g = self.syncedChildren).$each, $a.$$p = (TMP_7 = function(c){var self = TMP_7.$$s || this;
if (c == null) c = nil;
          return c.$update()}, TMP_7.$$s = self, TMP_7), $a).call($g)
        };
      };

      def.$setActive = function(ary) {
        var self = this;

        return self.active = ary;
      };

      def.$add = function(element, mode, id) {
        var $a, self = this, $case = nil;

        if (mode == null) {
          mode = "element"
        }
        if (id == null) {
          id = nil
        }
        if ((($a = self['$synced?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return nil};
        return (function() {$case = mode;if ("element"['$===']($case)) {if ((($a = element.$xylim()) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.list['$<<'](["element", ((($a = id) !== false && $a !== nil) ? $a : element.$id()), element]);
          return self.$update();
          } else {
          return nil
        }}else if ("xylim"['$===']($case)) {self.list['$<<'](["xylim", id, element]);
        return self.$update();}else { return nil }})();
      };

      def.$addXYLim = function(id, x0, x1, y0, y1) {
        var self = this;

        return self.$add($hash2(["x", "y"], {"x": [x0, x1], "y": [y0, y1]}), "xylim", id);
      };

      def.$to_x = function(x) {
        var self = this;

        return self.tr['$[]']("ax")['$*'](x)['$+'](self.tr['$[]']("bx"));
      };

      def.$to_X = function(x) {
        var self = this;

        return (x['$-'](self.tr['$[]']("bx")))['$/'](self.tr['$[]']("ax"));
      };

      def.$to_y = function(y) {
        var self = this;

        return self.tr['$[]']("ay")['$*'](y)['$+'](self.tr['$[]']("by"));
      };

      def.$to_Y = function(y) {
        var self = this;

        return (y['$-'](self.tr['$[]']("by")))['$/'](self.tr['$[]']("ay"));
      };

      def.$to_local = function(x, y) {
        var self = this;

        return [self.tr['$[]']("ax")['$*'](x)['$+'](self.tr['$[]']("bx")), self.tr['$[]']("ay")['$*'](y)['$+'](self.tr['$[]']("by"))];
      };

      def.$to_global = function(x, y) {
        var self = this;

        return [(x['$-'](self.tr['$[]']("bx")))['$/'](self.tr['$[]']("ax")), (y['$-'](self.tr['$[]']("by")))['$/'](self.tr['$[]']("ay"))];
      };

      def.$zoomActive = function() {
        var self = this;

        return self.zoom['$[]']("active");
      };

      def.$toggleZoomTo = function(plot, type) {
        var $a, $b, TMP_8, $c, TMP_9, $d, TMP_10, self = this, keys = nil;

        if (type == null) {
          type = ["xpos", "xneg", "ypos", "reset"]
        }
        self.zoom['$[]=']("active", self.zoom['$[]']("active")['$!']());
        if ((($a = self.zoom['$[]']("active")) !== nil && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self.zoomShapes) !== nil && (!$a.$$is_boolean || $a == true))) {
            } else {
            self.zoomShapes = $hash2([], {});
            keys = [];
            if ((($a = type['$include?']("xpos")) !== nil && (!$a.$$is_boolean || $a == true))) {
              keys = keys['$+'](["xposmore", "xposless"])};
            if ((($a = type['$include?']("xneg")) !== nil && (!$a.$$is_boolean || $a == true))) {
              keys = keys['$+'](["xnegmore", "xnegless"])};
            if ((($a = type['$include?']("ypos")) !== nil && (!$a.$$is_boolean || $a == true))) {
              keys = keys['$+'](["yposmore", "yposless"])};
            if ((($a = type['$include?']("yneg")) !== nil && (!$a.$$is_boolean || $a == true))) {
              keys = keys['$+'](["ynegmore", "ynegless"])};
            if ((($a = type['$include?']("reset")) !== nil && (!$a.$$is_boolean || $a == true))) {
              keys = keys['$+'](["reset"])};
            ($a = ($b = keys).$each, $a.$$p = (TMP_8 = function(k){var self = TMP_8.$$s || this;
              if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
            return self.zoomShapes['$[]='](k, new createjs.Shape())}, TMP_8.$$s = self, TMP_8), $a).call($b);
          };
          ($a = ($c = self.zoomShapes).$each_key, $a.$$p = (TMP_9 = function(k){var self = TMP_9.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.addChild(self.zoomShapes['$[]'](k))
					;}, TMP_9.$$s = self, TMP_9), $a).call($c);
          return self.$showZoom();
          } else {
          return ($a = ($d = self.zoomShapes).$each_key, $a.$$p = (TMP_10 = function(k){var self = TMP_10.$$s || this;
            if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
          
						plot.parent.removeChild(self.zoomShapes['$[]'](k))
					;}, TMP_10.$$s = self, TMP_10), $a).call($d)
        };
      };

      def.$showZoom = function() {
        var $a, $b, TMP_11, self = this, size = nil, inter = nil;

        size = 40;
        inter = 15;
        return ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_11 = function(k){var self = TMP_11.$$s || this, $case = nil;
          if (self.zoomShapes == null) self.zoomShapes = nil;
          if (self.dim == null) self.dim = nil;
if (k == null) k = nil;
        self.zoomShapes['$[]'](k).alpha=0.5;
          return (function() {$case = k;if ("xposmore"['$===']($case)) {return self.zoomShapes['$[]']("xposmore").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size,self.dim['$[]']("h")['$/'](2.0)-size['$/'](2)).lt(self.dim['$[]']("w")-1.5*size,self.dim['$[]']("h")['$/'](2.0)+size['$/'](2)).lt(self.dim['$[]']("w")-0.5*size,self.dim['$[]']("h")['$/'](2.0)).cp() ;}else if ("xposless"['$===']($case)) {return self.zoomShapes['$[]']("xposless").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")-1.5*size-inter,self.dim['$[]']("h")['$/'](2.0)-size['$/'](2)).lt(self.dim['$[]']("w")-1.5*size-inter,self.dim['$[]']("h")['$/'](2.0)+size['$/'](2)).lt(self.dim['$[]']("w")-2.5*size-inter,self.dim['$[]']("h")['$/'](2.0)).cp() ;}else if ("xnegmore"['$===']($case)) {return self.zoomShapes['$[]']("xnegmore").graphics.c().s("#000").f("#FFF").mt(1.5*size,self.dim['$[]']("h")['$/'](2.0)-size['$/'](2)).lt(1.5*size,self.dim['$[]']("h")['$/'](2.0)+size['$/'](2)).lt(0.5*size,self.dim['$[]']("h")['$/'](2.0)).cp() ;}else if ("xnegless"['$===']($case)) {return self.zoomShapes['$[]']("xnegless").graphics.c().s("#000").f("#FFF").mt(1.5*size+inter,self.dim['$[]']("h")['$/'](2.0)-size['$/'](2)).lt(1.5*size+inter,self.dim['$[]']("h")['$/'](2.0)+size['$/'](2)).lt(2.5*size+inter,self.dim['$[]']("h")['$/'](2.0)).cp() ;}else if ("ynegmore"['$===']($case)) {return self.zoomShapes['$[]']("ynegmore").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")['$/'](2.0)-size['$/'](2),self.dim['$[]']("h")-1.5*size).lt(self.dim['$[]']("w")['$/'](2.0)+size['$/'](2),self.dim['$[]']("h")-1.5*size).lt(self.dim['$[]']("w")['$/'](2.0),self.dim['$[]']("h")-0.5*size).cp() ;}else if ("ynegless"['$===']($case)) {return self.zoomShapes['$[]']("ynegless").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")['$/'](2.0)-size['$/'](2),self.dim['$[]']("h")-1.5*size-inter).lt(self.dim['$[]']("w")['$/'](2.0)+size['$/'](2),self.dim['$[]']("h")-1.5*size-inter).lt(self.dim['$[]']("w")['$/'](2.0),self.dim['$[]']("h")-2.5*size-inter).cp() ;}else if ("yposmore"['$===']($case)) {return self.zoomShapes['$[]']("yposmore").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")['$/'](2.0)-size['$/'](2),1.5*size).lt(self.dim['$[]']("w")['$/'](2.0)+size['$/'](2),1.5*size).lt(self.dim['$[]']("w")['$/'](2.0),0.5*size).cp() ;}else if ("yposless"['$===']($case)) {return self.zoomShapes['$[]']("yposless").graphics.c().s("#000").f("#FFF").mt(self.dim['$[]']("w")['$/'](2.0)-size['$/'](2),1.5*size+inter).lt(self.dim['$[]']("w")['$/'](2.0)+size['$/'](2),1.5*size+inter).lt(self.dim['$[]']("w")['$/'](2.0),2.5*size+inter).cp() ;}else if ("reset"['$===']($case)) {return self.zoomShapes['$[]']("reset").graphics.c().s("#000").f("#FFF").drawRect(self.dim['$[]']("w")['$/'](2.0)-size['$/'](2), self.dim['$[]']("h")['$/'](2.0)-size['$/'](2),size,size) ;}else { return nil }})();}, TMP_11.$$s = self, TMP_11), $a).call($b);
      };

      def.$hitZoom = function(x, y) {
        var $a, $b, TMP_12, self = this, select = nil;

        if ((($a = self.zoom['$[]']("active")) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          return nil
        };
        select = "none";
        ($a = ($b = self.zoomShapes).$each_key, $a.$$p = (TMP_12 = function(k){var self = TMP_12.$$s || this;
          if (self.zoomShapes == null) self.zoomShapes = nil;
if (k == null) k = nil;
        if(self.zoomShapes['$[]'](k).hitTest(x, y)) {select=k};;
          if (select['$==']("none")) {
            return nil
            } else {
            return ($breaker.$v = nil, $breaker)
          };}, TMP_12.$$s = self, TMP_12), $a).call($b);
        if (select['$==']("none")) {
          return select};
        self.$updateZoom(select);
        return select;
      };

      return (def.$updateZoom = function(mode, times) {
        var $a, $b, TMP_13, self = this, step = nil;

        if (times == null) {
          times = 1
        }
        step = (0.1)['$/'](2);
        return ($a = ($b = ($range(0, times, true))).$each, $a.$$p = (TMP_13 = function(){var self = TMP_13.$$s || this, $a, $b, $case = nil;
          if (self.zoom == null) self.zoom = nil;
          if (self.xylim == null) self.xylim = nil;

        return (function() {$case = mode;if ("xposmore"['$===']($case)) {return ($a = "x1", $b = self.zoom, $b['$[]=']($a, $b['$[]']($a)['$+'](step['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0)))))))}else if ("xposless"['$===']($case)) {if (self.zoom['$[]']("x1")['$<']((step['$-']((1)['$/'](2)))['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0)))))) {
            return nil
            } else {
            return self.zoom['$[]=']("x1", self.zoom['$[]']("x1")['$-'](step['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0))))))
          }}else if ("xnegmore"['$===']($case)) {return self.zoom['$[]=']("x0", self.zoom['$[]']("x0")['$-'](step['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0))))))}else if ("xnegless"['$===']($case)) {if (self.zoom['$[]']("x0")['$>'](((1)['$/'](2)['$-'](step))['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0)))))) {
            return nil
            } else {
            return ($a = "x0", $b = self.zoom, $b['$[]=']($a, $b['$[]']($a)['$+'](step['$*']((self.xylim['$[]']("x")['$[]'](1)['$-'](self.xylim['$[]']("x")['$[]'](0)))))))
          }}else if ("yposmore"['$===']($case)) {return ($a = "y1", $b = self.zoom, $b['$[]=']($a, $b['$[]']($a)['$+'](step['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0)))))))}else if ("yposless"['$===']($case)) {if (self.zoom['$[]']("y1")['$<']((step['$-']((1)['$/'](2)))['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0)))))) {
            return nil
            } else {
            return self.zoom['$[]=']("y1", self.zoom['$[]']("y1")['$-'](step['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0))))))
          }}else if ("ynegmore"['$===']($case)) {return self.zoom['$[]=']("y0", self.zoom['$[]']("y1")['$-'](step['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0))))))}else if ("ynegless"['$===']($case)) {if (self.zoom['$[]']("y0")['$>'](((1)['$/'](2)['$-'](step))['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0)))))) {
            return nil
            } else {
            return ($a = "y0", $b = self.zoom, $b['$[]=']($a, $b['$[]']($a)['$+'](step['$*']((self.xylim['$[]']("y")['$[]'](1)['$-'](self.xylim['$[]']("y")['$[]'](0)))))))
          }}else if ("reset"['$===']($case)) {return self.zoom['$[]=']("x0", self.zoom['$[]=']("x1", self.zoom['$[]=']("y0", self.zoom['$[]=']("y1", 0.0))))}else { return nil }})()}, TMP_13.$$s = self, TMP_13), $a).call($b);
      }, nil) && 'updateZoom';
    })(self, null);

    (function($base, $super) {
      function $Child(){};
      var self = $Child = $klass($base, $super, 'Child', $Child);

      var def = self.$$proto, $scope = self.$$scope;

      self.$attr_accessor("id", "plot", "graph", "shape", "style", "xylim");

      return (def.$initialize = function() {
        var self = this;

        return nil;
      }, nil) && 'initialize';
    })(self, null);

    (function($base, $super) {
      function $Curve(){};
      var self = $Curve = $klass($base, $super, 'Curve', $Curve);

      var def = self.$$proto, $scope = self.$$scope;

      def.type = def.bounds = def.length = def.plot = def.expAxisShape = def.graph = def.summaryShapes = def.distrib = def.step = def.x = def.y = def.shape = def.style = nil;
      self.$attr_accessor("distrib", "bounds", "kind", "type", "style");

      def.$initialize = function(id, type, bounds, style, length) {
        var $a, $b, self = this, $case = nil;

        if (id == null) {
          id = nil
        }
        if (type == null) {
          type = "cont"
        }
        if (bounds == null) {
          bounds = [0, 1]
        }
        if (style == null) {
          style = $hash2(["close", "stroke", "fill", "thickness"], {"close": true, "stroke": "#000", "fill": "rgba(200,200,255,0.5)", "thickness": 3})
        }
        if (length == null) {
          length = 512
        }
        if ((($a = (($b = Opal.cvars['@@curveCpt']) == null ? nil : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@curveCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil) ? $a : "curve"['$+'](((Opal.cvars['@@curveCpt'] = (($b = Opal.cvars['@@curveCpt']) == null ? nil : $b)['$+'](1))).$to_s()));
        self.type = type;
        $case = self.type;if ("cont"['$===']($case)) {$a = [bounds, length], self.bounds = $a[0], self.length = $a[1]}else if ("disc"['$===']($case)) {self.bounds = bounds;
        self.length = self.bounds.$length();
        self.$initStep();};
        self.style = style;
        self.shape = new createjs.Shape();
        self.x = $scope.get('CqlsAEP').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length);
        self.kind = "density";
        self.summaryShapes = [new createjs.Shape(), new createjs.Shape()];
        return self.expAxisShape = new createjs.Shape();
      };

      def.$attachExpAxis = function(ratio) {
        var self = this;

        return self.plot.$addChild(self.expAxisShape, [self, "drawExpAxis", [ratio]]);
      };

      def.$drawExpAxis = function(ratio) {
        var self = this;

        self.expAxisShape.visible=true;
        return self.expAxisShape.graphics.c().s("#000").ss(1).mt(self.graph.$dim()['$[]']("x"),self.graph.$dim()['$[]']("h")['$*'](ratio)).lt(self.graph.$dim()['$[]']("x")['$+'](self.graph.$dim()['$[]']("w")),self.graph.$dim()['$[]']("h")['$*'](ratio));
      };

      def.$attachSummary = function() {
        var self = this;

        self.plot.$addChild(self.summaryShapes['$[]'](0), [self, "drawMean"]);
        return self.plot.$addChild(self.summaryShapes['$[]'](1), [self, "drawSD"]);
      };

      def.$drawMean = function() {
        var self = this;

        return self.summaryShapes['$[]'](0).graphics.c().s("#000").ss(1).mt(self.graph.$to_X(self.distrib.$mean()),self.graph.$dim()['$[]']("y")).lt(self.graph.$to_X(self.distrib.$mean()),self.graph.$dim()['$[]']("y")['$+'](self.graph.$dim()['$[]']("h")));
      };

      def.$drawSD = function() {
        var $a, self = this, x = nil, y = nil, h = nil;

        $a = [10, 10], x = $a[0], y = $a[1];
        h = self.distrib.$maxPdf()['$/'](2.0);
        if (self.type['$==']("disc")) {
          h = h['$/'](self.step)};
        h = self.graph.$to_Y(h);
        
				self.summaryShapes['$[]'](1).graphics.c().s("#000").ss(1)		
				.mt(self.graph.$to_X(self.distrib.$mean()['$-'](self.distrib.$stdDev()))+x,h-y)
				.lt(self.graph.$to_X(self.distrib.$mean()['$-'](self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X(self.distrib.$mean()['$-'](self.distrib.$stdDev()))+x,h+y)
				.mt(self.graph.$to_X(self.distrib.$mean()['$-'](self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X(self.distrib.$mean()['$+'](self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X(self.distrib.$mean()['$+'](self.distrib.$stdDev()))-x,h-y)
				.mt(self.graph.$to_X(self.distrib.$mean()['$+'](self.distrib.$stdDev())),h)
				.lt(self.graph.$to_X(self.distrib.$mean()['$+'](self.distrib.$stdDev()))-x,h+y)
			;
      };

      def.$sample = function(n) {
        var self = this;

        if (n == null) {
          n = 1
        }
        return self.distrib.$sample(n);
      };

      def.$y = function(x) {
        var $a, $b, TMP_14, self = this, y = nil;

        y = self.distrib.$pdf(x);
        if (self.distrib.$type()['$==']("disc")) {
          ($a = ($b = y)['$map!'], $a.$$p = (TMP_14 = function(e){var self = TMP_14.$$s || this;
            if (self.distrib == null) self.distrib = nil;
if (e == null) e = nil;
          return e['$/'](self.distrib.$step())}, TMP_14.$$s = self, TMP_14), $a).call($b)};
        y = y.map(function(e) {return Math.random()*e;});
        return y;
      };

      def.$xy = function(n) {
        var self = this, x = nil, y = nil;

        if (n == null) {
          n = 1
        }
        x = self.$sample(n);
        y = self.$y(x);
        return $hash2(["x", "y"], {"x": x, "y": y});
      };

      def.$initStep = function() {
        var $a, $b, TMP_15, self = this;

        return self.step = ($a = ($b = ($range(1, self.bounds.$length(), true))).$map, $a.$$p = (TMP_15 = function(i){var self = TMP_15.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return (self.bounds['$[]'](i)['$-'](self.bounds['$[]'](i['$-'](1)))).$abs()}, TMP_15.$$s = self, TMP_15), $a).call($b).$min().$to_f();
      };

      def.$setDistrib = function(name, params) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$set(name, params);
        return self.$initDistrib();
      };

      def.$setDistribAs = function(dist) {
        var self = this;

        self.distrib = dist;
        return self.$initDistrib();
      };

      def.$setDistribAsTransf = function(transf, dist) {
        var self = this;

        self.distrib = $scope.get('Distribution').$new();
        self.distrib.$setAsTransfOf(dist, transf);
        return self.$initDistrib();
      };

      def['$regular?'] = function() {
        var self = this;

        return self.distrib['$regular?']();
      };

      def.$initDistrib = function() {
        var $a, $b, TMP_16, self = this, $case = nil;

        self.type = self.distrib.$type();
        self.bounds = self.distrib.$bounds();
        $case = self.type;if ("cont"['$===']($case)) {self.x = $scope.get('CqlsAEP').$seq(self.bounds['$[]'](0), self.bounds['$[]'](1), self.length)}else if ("disc"['$===']($case)) {self.$initStep();
        self.x = self.bounds;};
        self.y = self.distrib.$pdf(self.x);
        if (self.type['$==']("disc")) {
          ($a = ($b = self.y)['$map!'], $a.$$p = (TMP_16 = function(e){var self = TMP_16.$$s || this;
            if (self.step == null) self.step = nil;
if (e == null) e = nil;
          return e['$/'](self.step)}, TMP_16.$$s = self, TMP_16), $a).call($b)};
        return self.$initXYLim();
      };

      def.$initXYLim = function() {
        var self = this, xlim = nil;

        xlim = (function() {if (self.type['$==']("cont")) {
          return self.bounds
          } else {
          return [self.bounds['$[]'](0)['$-'](self.step['$/'](2.0)), self.bounds['$[]'](-1)['$+'](self.step['$/'](2.0))]
        }; return nil; })();
        return self.xylim = $hash2(["x", "y"], {"x": $scope.get('Graph').$adjust(xlim), "y": $scope.get('Graph').$adjust([0, self.y.$max()])});
      };

      def.$draw = function(shape, graph, style) {
        var self = this;

        if (shape == null) {
          shape = self.shape
        }
        if (graph == null) {
          graph = self.graph
        }
        if (style == null) {
          style = self.style
        }
        if (self.type['$==']("cont")) {
          return self.$drawCont(shape, graph, style)
          } else {
          return self.$drawDisc(shape, graph, style)
        };
      };

      def.$drawCont = function(shape, graph, style) {
        var $a, $b, TMP_17, self = this;

        if (shape == null) {
          shape = self.shape
        }
        if (graph == null) {
          graph = self.graph
        }
        if (style == null) {
          style = self.style
        }
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        shape.graphics.mt(graph.$to_X(self.x['$[]'](0)),graph.$to_Y(0.0));
        ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_17 = function(i){var self = TMP_17.$$s || this;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        return shape.graphics.lt(graph.$to_X(self.x['$[]'](i)),graph.$to_Y(self.y['$[]'](i)));}, TMP_17.$$s = self, TMP_17), $a).call($b);
        shape.graphics.lt(graph.$to_X(self.x['$[]'](-1)),graph.$to_Y(0.0));
        if ((($a = style['$[]']("close")) !== nil && (!$a.$$is_boolean || $a == true))) {
          return shape.graphics.cp();
          } else {
          return nil
        };
      };

      return (def.$drawDisc = function(shape, graph, style) {
        var $a, $b, TMP_18, self = this, s = nil;

        if (shape == null) {
          shape = self.shape
        }
        if (graph == null) {
          graph = self.graph
        }
        if (style == null) {
          style = self.style
        }
        s = self.step['$/'](2.0);
        
				shape.graphics.clear();
				if(style['$[]']("close")) {shape.graphics.f(style['$[]']("fill"));}
				shape.graphics.s(style['$[]']("stroke")).ss(style['$[]']("thickness"));
			;
        return ($a = ($b = ($range(0, self.x.$length(), true))).$each, $a.$$p = (TMP_18 = function(i){var self = TMP_18.$$s || this, $a;
          if (self.x == null) self.x = nil;
          if (self.y == null) self.y = nil;
if (i == null) i = nil;
        
				 	shape.graphics.mt(graph.$to_X(self.x['$[]'](i)['$-'](s)),graph.$to_Y(0.0))
					.lt(graph.$to_X(self.x['$[]'](i)['$-'](s)),graph.$to_Y(self.y['$[]'](i)))
					.lt(graph.$to_X(self.x['$[]'](i)['$+'](s)),graph.$to_Y(self.y['$[]'](i)))
			 		.lt(graph.$to_X(self.x['$[]'](i)['$+'](s)),graph.$to_Y(0.0))
			 	;
          if ((($a = style['$[]']("close")) !== nil && (!$a.$$is_boolean || $a == true))) {
            return shape.graphics.cp();
            } else {
            return nil
          };}, TMP_18.$$s = self, TMP_18), $a).call($b);
      }, nil) && 'drawDisc';
    })(self, $scope.get('Child'));

    (function($base, $super) {
      function $Hist(){};
      var self = $Hist = $klass($base, $super, 'Hist', $Hist);

      var def = self.$$proto, $scope = self.$$scope;

      def.type = def.curve = def.curveShape = def.graph = def.style = def.plot = def.summaryShapes = def.mean = def.step = def.sd = def.bounds = def.nbPart = def.ind = def.nbTot = def.cptICTot = def.levelNext = def.levels = def.cpt = def.level = def.shape = def.aep = nil;
      self.$attr_accessor("bounds", "level", "levels", "nbPart", "nbTot", "curveShape", "type", "aep", "style", "cptICTot");

      def.$initialize = function(id, type, bounds, style, levels) {
        var $a, $b, self = this, $case = nil;

        if (id == null) {
          id = nil
        }
        if (type == null) {
          type = "cont"
        }
        if (bounds == null) {
          bounds = [0, 1]
        }
        if (style == null) {
          style = $hash2(["hist", "mean", "sd", "curve"], {"hist": $hash2(["fill", "stroke"], {"fill": "rgba(100,100,255,0.5)", "stroke": "#000000"}), "mean": $hash2(["stroke", "thickness"], {"stroke": "rgba(100,100,255,1)", "thickness": 1}), "sd": $hash2(["stroke", "thickness", "fill"], {"stroke": "rgba(100,100,255,1)", "thickness": 1, "fill": "rgba(100,100,255,1)"}), "curve": $hash2(["close", "fill", "stroke", "thickness"], {"close": false, "fill": "#000", "stroke": "rgba(0,0,0,.4)", "thickness": 3})})
        }
        if (levels == null) {
          levels = 8
        }
        if ((($a = (($b = Opal.cvars['@@histCpt']) == null ? nil : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@histCpt'] = -1)
        };
        self.id = ((($a = id) !== false && $a !== nil) ? $a : "hist"['$+'](((Opal.cvars['@@histCpt'] = (($b = Opal.cvars['@@histCpt']) == null ? nil : $b)['$+'](1))).$to_s()));
        self.type = type;
        $case = self.type;if ("cont"['$===']($case)) {$a = [bounds, levels, 4], self.bounds = $a[0], self.levels = $a[1], self.level = $a[2];
        self.nbPart = (2)['$**'](levels);}else if ("disc"['$===']($case)) {self.bounds = bounds};
        self.$init();
        self.style = style;
        self.shape = new createjs.Shape();
        self.curveShape = new createjs.Shape();
        self.aep = $hash2([], {});
        self.aepLastStep = $hash2([], {});
        return self.summaryShapes = [new createjs.Shape(), new createjs.Shape()];
      };

      def.$drawCurve = function() {
        var self = this;

        return self.curve.$draw(self.curveShape, self.graph, self.style['$[]']("curve"));
      };

      def.$attachSummary = function() {
        var self = this;

        self.plot.$addChild(self.summaryShapes['$[]'](0), [self, "drawMean"]);
        return self.plot.$addChild(self.summaryShapes['$[]'](1), [self, "drawSD"]);
      };

      def.$drawMean = function() {
        var self = this;

        return self.summaryShapes['$[]'](0).graphics.c().s(self.style['$[]']("mean")['$[]']("stroke")).ss(self.style['$[]']("mean")['$[]']("thickness")).mt(self.graph.$to_X(self.mean['$[]'](0)),self.graph.$dim()['$[]']("y")).lt(self.graph.$to_X(self.mean['$[]'](0)),self.graph.$dim()['$[]']("y")['$+'](self.graph.$dim()['$[]']("h")));
      };

      def.$drawSD = function() {
        var $a, self = this, x = nil, y = nil, h = nil;

        $a = [10, 10], x = $a[0], y = $a[1];
        h = self.curve.$distrib().$maxPdf()['$/'](2.0);
        if (self.type['$==']("disc")) {
          h = h['$/'](self.step)};
        h = self.graph.$to_Y(h);
        
				self.summaryShapes['$[]'](1).graphics.c().s(self.style['$[]']("mean")['$[]']("stroke")).ss(1)
				.mt(self.graph.$to_X(self.mean['$[]'](0)['$-'](self.sd))+x,h-y)
				.lt(self.graph.$to_X(self.mean['$[]'](0)['$-'](self.sd)),h)
				.lt(self.graph.$to_X(self.mean['$[]'](0)['$-'](self.sd))+x,h+y)
				.mt(self.graph.$to_X(self.mean['$[]'](0)['$-'](self.sd)),h)
				.lt(self.graph.$to_X(self.mean['$[]'](0)['$+'](self.sd)),h)
				.lt(self.graph.$to_X(self.mean['$[]'](0)['$+'](self.sd))-x,h-y)
				.mt(self.graph.$to_X(self.mean['$[]'](0)['$+'](self.sd)),h)
				.lt(self.graph.$to_X(self.mean['$[]'](0)['$+'](self.sd))-x,h+y)
			;
      };

      def.$updateBounds = function() {
        var self = this;

        return self.bounds = self.curve.$bounds();
      };

      def['$regular?'] = function() {
        var self = this;

        return self.curve['$regular?']();
      };

      def.$init = function() {
        var $a, $b, TMP_19, $c, TMP_20, self = this, $case = nil;

        $case = self.type;if ("cont"['$===']($case)) {self.step = (self.bounds['$[]'](1)['$-'](self.bounds['$[]'](0))).$to_f()['$/'](self.nbPart);
        $a = [[0]['$*'](self.nbPart), 0], self.cpt = $a[0], self.nbTot = $a[1];
        self.outside = [0]['$*'](2);}else if ("disc"['$===']($case)) {self.step = ($a = ($b = ($range(1, self.bounds.$length(), true))).$map, $a.$$p = (TMP_19 = function(i){var self = TMP_19.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return (self.bounds['$[]'](i)['$-'](self.bounds['$[]'](i['$-'](1)))).$abs()}, TMP_19.$$s = self, TMP_19), $a).call($b).$min();
        $a = [[0]['$*'](self.bounds.$length()), 0], self.cpt = $a[0], self.nbTot = $a[1];
        self.outside = [0]['$*'](2);
        if ((($a = self['$regular?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.ind = $hash2([], {});
          ($a = ($c = self.bounds).$each_with_index, $a.$$p = (TMP_20 = function(v, i){var self = TMP_20.$$s || this;
            if (self.ind == null) self.ind = nil;
if (v == null) v = nil;if (i == null) i = nil;
          return self.ind['$[]='](v, i)}, TMP_20.$$s = self, TMP_20), $a).call($c);
        };};
        return $a = [[0, 0], 0, 0], self.mean = $a[0], self.sd = $a[1], self.cptICTot = $a[2];
      };

      def.$index = function(x, step) {
        var $a, self = this;

        if (step == null) {
          step = self.step
        }
        if ((($a = self['$regular?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return ((x['$-'](self.bounds['$[]'](0)))['$/'](step)).$floor()
          } else {
          return self.ind['$[]']($scope.get('CqlsAEP').$quantize(x))
        };
      };

      def.$reset = function(type) {
        var self = this;

        if (type == null) {
          type = nil
        }
        self.type = (function() {if (type !== false && type !== nil) {
          return type
          } else {
          return self.curve.$type()
        }; return nil; })();
        self.$updateBounds();
        return self.$init();
      };

      def.$attachCurve = function(curve) {
        var self = this;

        self.curve = curve;
        self.$reset();
        self.graph.$add(self.curve);
        self.$drawCurve();
        self.plot.$addChild(self.curveShape, [self, "drawCurve"], 1);
        return self.curveShape.visible=false;
      };

      def.$add = function(x) {
        var $a, $b, TMP_21, $c, TMP_22, $d, TMP_23, $e, TMP_24, self = this, $case = nil;

        $case = self.type;if ("cont"['$===']($case)) {($a = ($b = x).$each, $a.$$p = (TMP_21 = function(e){var self = TMP_21.$$s || this, $a, $b;
          if (self.bounds == null) self.bounds = nil;
          if (self.cpt == null) self.cpt = nil;
          if (self.outside == null) self.outside = nil;
if (e == null) e = nil;
        if ((($a = (($b = self.bounds['$[]'](0)['$<='](e)) ? e['$<='](self.bounds['$[]'](-1)) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            return ($a = self.$index(e), $b = self.cpt, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))
            } else {
            if (e['$<'](self.bounds['$[]'](0))) {
              ($a = 0, $b = self.outside, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))};
            if (e['$>'](self.bounds['$[]'](-1))) {
              return ($a = 1, $b = self.outside, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))
              } else {
              return nil
            };
          }}, TMP_21.$$s = self, TMP_21), $a).call($b)}else if ("disc"['$===']($case)) {($a = ($c = x).$each, $a.$$p = (TMP_22 = function(e){var self = TMP_22.$$s || this, $a, $b, i = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.cpt == null) self.cpt = nil;
          if (self.outside == null) self.outside = nil;
if (e == null) e = nil;
        i = self.$index(e);
          if ((($a = (($b = (0)['$<='](i)) ? i['$<'](self.bounds.$length()) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            return ($a = i, $b = self.cpt, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))
            } else {
            if (i['$<'](0)) {
              ($a = 0, $b = self.outside, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))};
            if (i['$>='](self.bounds.$length())) {
              return ($a = 1, $b = self.outside, $b['$[]=']($a, $b['$[]']($a)['$+'](1)))
              } else {
              return nil
            };
          };}, TMP_22.$$s = self, TMP_22), $a).call($c)};
        self.mean['$[]='](0, ($a = ($d = x).$inject, $a.$$p = (TMP_23 = function(e, e2){var self = TMP_23.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
        return e = e['$+'](e2)}, TMP_23.$$s = self, TMP_23), $a).call($d, self.nbTot.$to_f()['$*'](self.mean['$[]'](0))));
        self.mean['$[]='](1, ($a = ($e = x).$inject, $a.$$p = (TMP_24 = function(e, e2){var self = TMP_24.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
        return e = e['$+'](e2['$**'](2))}, TMP_24.$$s = self, TMP_24), $a).call($e, self.nbTot.$to_f()['$*'](self.mean['$[]'](1))));
        self.nbTot = self.nbTot['$+'](x.$length());
        self.mean['$[]='](0, self.mean['$[]'](0)['$/'](self.nbTot.$to_f()));
        self.mean['$[]='](1, self.mean['$[]'](1)['$/'](self.nbTot.$to_f()));
        return self.sd = Math.sqrt(self.mean['$[]'](1)['$-'](self.mean['$[]'](0)['$**'](2)));
      };

      def.$incCptIC = function(cpt) {
        var self = this;

        return self.cptICTot = self.cptICTot['$+'](cpt);
      };

      def.$level = function(val, mode) {
        var $a, $b, self = this, level = nil;

        if (val == null) {
          val = 0
        }
        if (mode == null) {
          mode = "inc"
        }
        if (self.type['$==']("disc")) {
          return nil};
        if ((($a = (($b = mode['$==']("inc")) ? val['$=='](0) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.levelNext};
        level = ((function() {if (mode['$==']("inc")) {
          return self.levelNext
          } else {
          return 0
        }; return nil; })())['$+'](val);
        if (level['$<'](0)) {
          level = 0};
        if (level['$>'](self.levels)) {
          level = self.levels};
        self.levelNext = level;
        self.$acceptLevelNext();
        return self.levelNext;
      };

      def.$acceptLevelNext = function() {
        var $a, self = this;

        if ((($a = cqlsAEP.i.allowLevelChange) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.level = self.levelNext
          } else {
          return nil
        };
      };

      def.$counts = function() {
        var $a, $b, TMP_25, self = this, cptLevel = nil;

        if (self.type['$==']("disc")) {
          return self.cpt.$dup()};
        cptLevel = [0]['$*'](((2)['$**'](self.level)));
        ($a = ($b = ($range(0, self.nbPart, true))).$each, $a.$$p = (TMP_25 = function(i){var self = TMP_25.$$s || this, $a, $b;
          if (self.levels == null) self.levels = nil;
          if (self.level == null) self.level = nil;
          if (self.cpt == null) self.cpt = nil;
if (i == null) i = nil;
        return ($a = i['$/']((2)['$**']((self.levels['$-'](self.level)))), $b = cptLevel, $b['$[]=']($a, $b['$[]']($a)['$+'](self.cpt['$[]'](i))))}, TMP_25.$$s = self, TMP_25), $a).call($b);
        return cptLevel;
      };

      def.$prob = function() {
        var $a, $b, TMP_26, self = this;

        return ($a = ($b = self.$counts()).$map, $a.$$p = (TMP_26 = function(e){var self = TMP_26.$$s || this;
          if (self.nbTot == null) self.nbTot = nil;
if (e == null) e = nil;
        return e.$to_f()['$/'](self.nbTot.$to_f())}, TMP_26.$$s = self, TMP_26), $a).call($b);
      };

      def.$density = function(nbTot) {
        var $a, $b, TMP_27, self = this, cpt = nil, step = nil, nbTotal = nil;

        if (nbTot == null) {
          nbTot = nil
        }
        cpt = self.$counts();
        step = ((function() {if (self.type['$==']("cont")) {
          return self.step['$*'](((2)['$**']((self.levels['$-'](self.level)))))
          } else {
          return self.step
        }; return nil; })());
        nbTotal = (function() {if (nbTot !== false && nbTot !== nil) {
          return nbTot
          } else {
          return self.nbTot
        }; return nil; })();
        return ($a = ($b = cpt).$map, $a.$$p = (TMP_27 = function(e){var self = TMP_27.$$s || this;
if (e == null) e = nil;
        return e.$to_f()['$/'](nbTotal.$to_f())['$/'](step)}, TMP_27.$$s = self, TMP_27), $a).call($b);
      };

      def.$partBounds = function() {
        var $a, $b, TMP_28, $c, TMP_29, self = this, $case = nil, step = nil, s = nil;

        return (function() {$case = self.type;if ("cont"['$===']($case)) {step = self.step['$*'](((2)['$**']((self.levels['$-'](self.level)))));
        return (($a = ($b = ($range(0, ((2)['$**'](self.level)), true))).$map, $a.$$p = (TMP_28 = function(i){var self = TMP_28.$$s || this;
          if (self.bounds == null) self.bounds = nil;
if (i == null) i = nil;
        return self.bounds['$[]'](0)['$+'](i['$*'](step))}, TMP_28.$$s = self, TMP_28), $a).call($b))['$+']([self.bounds['$[]'](1)]);}else if ("disc"['$===']($case)) {s = self.step['$/'](2.0);
        return (($a = ($c = self.bounds).$map, $a.$$p = (TMP_29 = function(v){var self = TMP_29.$$s || this;
if (v == null) v = nil;
        return v['$-'](s)}, TMP_29.$$s = self, TMP_29), $a).call($c))['$+']([self.bounds['$[]'](-1)['$+'](s)]);}else { return nil }})();
      };

      def.$draw = function(nbTot) {
        var $a, $b, TMP_30, self = this, d = nil, b = nil, l = nil;

        if (nbTot == null) {
          nbTot = nil
        }
        d = self.$density(nbTot);
        b = self.$partBounds();
        l = (function() {if (self.type['$==']("cont")) {
          return (2)['$**'](self.level)
          } else {
          return self.bounds.$length()
        }; return nil; })();
        self.shape.graphics.c().f(self.style['$[]']("hist")['$[]']("fill")).s(self.style['$[]']("hist")['$[]']("stroke")).mt(self.graph.$to_X(b['$[]'](0)),self.graph.$to_Y(0.0));
        ($a = ($b = ($range(0, (l), true))).$each, $a.$$p = (TMP_30 = function(i){var self = TMP_30.$$s || this;
          if (self.type == null) self.type = nil;
          if (self.shape == null) self.shape = nil;
          if (self.graph == null) self.graph = nil;
          if (self.step == null) self.step = nil;
if (i == null) i = nil;
        
					if(self.type['$==']("disc")) {
						self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)),self.graph.$to_Y(0));
					}
					self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)),self.graph.$to_Y(d['$[]'](i)));
					if(self['$regular?']()) {
						self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i['$+'](1))),self.graph.$to_Y(d['$[]'](i)));
						if(self.type['$==']("disc")) {
							self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i['$+'](1))),self.graph.$to_Y(0));
						}
					}
					else {//then implicitly discrete
						self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)['$+'](self.step)),self.graph.$to_Y(d['$[]'](i)));
						self.shape.graphics.lt(self.graph.$to_X(b['$[]'](i)['$+'](self.step)),self.graph.$to_Y(0));
					}			
				;}, TMP_30.$$s = self, TMP_30), $a).call($b);
        self.shape.graphics.lt(self.graph.$to_X(b['$[]'](-1)),self.graph.$to_Y(0.0));
        return self.shape.graphics.cp();
      };

      return (def.$updateHistAEP = function(x, mode) {
        var $a, $b, TMP_31, $c, TMP_32, $d, TMP_33, $e, TMP_34, self = this, $case = nil;

        if (mode == null) {
          mode = "normal"
        }
        self.aep['$[]=']("cpt", ((function() {if (mode['$==']("normal")) {
          return self.$counts()
          } else {
          return ([0]['$*'](((function() {if (self.type['$==']("disc")) {
            return self.bounds.$length()
            } else {
            return ((2)['$**'](self.level))
          }; return nil; })())))
        }; return nil; })()));
        self.aep['$[]=']("step", (function() {if (self.type['$==']("cont")) {
          return (self.bounds['$[]'](1)['$-'](self.bounds['$[]'](0))).$to_f()['$/']((2)['$**'](self.level).$to_f())
          } else {
          return self.step
        }; return nil; })());
        self.aep['$[]=']("nbTot", ((function() {if ((($a = (["normal", "reduced"]['$include?'](mode))) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.nbTot
          } else {
          return 0
        }; return nil; })())['$+'](x.$length()));
        $a = [[], []], self.aep['$[]=']("xRect", $a[0]), self.aep['$[]=']("yRect", $a[1]);
        $case = self.type;if ("cont"['$===']($case)) {($a = ($b = x).$each_with_index, $a.$$p = (TMP_31 = function(e, i){var self = TMP_31.$$s || this, $a, $b, pos = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.aep == null) self.aep = nil;
if (e == null) e = nil;if (i == null) i = nil;
        if ((($a = (($b = self.bounds['$[]'](0)['$<='](e)) ? e['$<='](self.bounds['$[]'](-1)) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            pos = ((e['$-'](self.bounds['$[]'](0)))['$/']((self.aep['$[]']("step")))).$floor();
            self.aep['$[]']("xRect")['$[]='](i, self.bounds['$[]'](0)['$+']((self.aep['$[]']("step")['$*'](pos.$to_f()))));
            ($a = pos, $b = self.aep['$[]']("cpt"), $b['$[]=']($a, $b['$[]']($a)['$+'](1)));
            return self.aep['$[]']("yRect")['$[]='](i, self.aep['$[]']("cpt")['$[]'](pos).$to_f()['$/'](self.aep['$[]']("nbTot").$to_f())['$/'](self.aep['$[]']("step")));
            } else {
            pos = ((e['$-'](self.bounds['$[]'](0)))['$/']((self.aep['$[]']("step")))).$floor();
            self.aep['$[]']("xRect")['$[]='](i, self.bounds['$[]'](0)['$+']((self.aep['$[]']("step")['$*'](pos.$to_f()))));
            return self.aep['$[]']("yRect")['$[]='](i, 0);
          }}, TMP_31.$$s = self, TMP_31), $a).call($b)}else if ("disc"['$===']($case)) {($a = ($c = x).$each_with_index, $a.$$p = (TMP_32 = function(e, i){var self = TMP_32.$$s || this, $a, $b, pos = nil;
          if (self.bounds == null) self.bounds = nil;
          if (self.aep == null) self.aep = nil;
if (e == null) e = nil;if (i == null) i = nil;
        pos = self.$index(e);
          if ((($a = (($b = (0)['$<='](pos)) ? pos['$<'](self.bounds.$length()) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            self.aep['$[]']("xRect")['$[]='](i, self.bounds['$[]'](pos)['$-'](self.aep['$[]']("step")['$/'](2.0)));
            ($a = pos, $b = self.aep['$[]']("cpt"), $b['$[]=']($a, $b['$[]']($a)['$+'](1)));
            return self.aep['$[]']("yRect")['$[]='](i, self.aep['$[]']("cpt")['$[]'](pos).$to_f()['$/'](self.aep['$[]']("nbTot").$to_f())['$/'](self.aep['$[]']("step")));
            } else {
            self.aep['$[]']("xRect")['$[]='](i, e['$-'](self.aep['$[]']("step")['$/'](2.0)));
            return self.aep['$[]']("yRect")['$[]='](i, 0);
          };}, TMP_32.$$s = self, TMP_32), $a).call($c)};
        if (mode['$==']("new")) {
          self.aep['$[]=']("mean", [(($a = ($d = x).$inject, $a.$$p = (TMP_33 = function(e, e2){var self = TMP_33.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = e['$+'](e2)}, TMP_33.$$s = self, TMP_33), $a).call($d, 0))['$/'](self.aep['$[]']("nbTot")), (($a = ($e = x).$inject, $a.$$p = (TMP_34 = function(e, e2){var self = TMP_34.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = e['$+'](e2['$**'](2))}, TMP_34.$$s = self, TMP_34), $a).call($e, 0))['$/'](self.aep['$[]']("nbTot"))]);
          return self.aep['$[]=']("sd", Math.sqrt(self.aep['$[]']("mean")['$[]'](1)['$-'](self.aep['$[]']("mean")['$[]'](0)['$**'](2))));
          } else {
          return nil
        };
      }, nil) && 'updateHistAEP';
    })(self, $scope.get('Child'));

    (function($base, $super) {
      function $Play(){};
      var self = $Play = $klass($base, $super, 'Play', $Play);

      var def = self.$$proto, $scope = self.$$scope;

      def.plotExp = def.plotHist = def.graphHist = def.graphExp = def.exp = def.hist = def.ratioExpAxis = def.transf = def.checkTCL = def.n = def.x = def.y = def.mLevel = def.mLevels = def.nold = def.transfList = def.curIndHist = def.histCur = def.statMode = def.n01 = def.alpha = def.ind = def.aep = def.w = def.h = def.wX = def.hY = def.modeHidden = def.time = def.cptIC = def.nbSim = nil;
      self.$attr_accessor("exp");

      def.$initialize = function(plotExp, plotHist) {
        var $a, self = this;

        if (plotExp == null) {
          plotExp = cqlsAEP.s.plot
        }
        if (plotHist == null) {
          plotHist = cqlsAEP.h.plot
        }
        
				cqlsAEP.actors={pt:[],rect:[],line:[]};
				cqlsAEP.tweens={pt:[],rect:[],line:[]};
	    		cqlsAEP.m.nbsSimMax=cqlsAEP.m.nbsSim["1000"][cqlsAEP.m.nbsSim["1000"].length-1];
	    		//console.log("nbsSImMax="+cqlsAEP.m.nbsSimMax);
	     		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
					var rect=new createjs.Shape();
	    			cqlsAEP.actors.rect.push(rect);
			    	rect.visible=false;
			    	cqlsAEP.m.stage.addChild(rect);
	    		}
	    		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
					var line=new createjs.Shape();
	    			cqlsAEP.actors.line.push(line);
			    	line.visible=false;
			    	cqlsAEP.m.stage.addChild(line);
	    		}
	    		for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
	    			var pt=new createjs.Shape();
	    			cqlsAEP.actors.pt.push(pt);
			    	pt.visible=false;
			    	pt.x=0;pt.y=0;
			    	cqlsAEP.m.stage.addChild(pt);
	    		}
			
        self.stage = cqlsAEP.m.stage;
        $a = [plotExp, plotHist], self.plotExp = $a[0], self.plotHist = $a[1];
        $a = [self.plotExp.$graph(), self.plotHist.$graph()], self.graphExp = $a[0], self.graphHist = $a[1];
        self.graphHist.$syncTo(self.graphExp);
        self.exp = [$scope.get('Curve').$new(), $scope.get('Curve').$new()];
        self.$setDistrib();
        self.$setDistrib("chi2", [10], 1);
        self.plotExp.$addChild(self.exp['$[]'](0));
        self.plotExp.$addChild(self.exp['$[]'](1));
        self.exp['$[]'](1).$style()['$[]=']("fill", createjs.Graphics.getRGB(200,200,200,.3));
        self.exp['$[]'](1).$style()['$[]=']("thickness", 1);
        self.hist = [$scope.get('Hist').$new(), $scope.get('Hist').$new()];
        self.plotHist.$addChild(self.hist['$[]'](0));
        self.plotHist.$addChild(self.hist['$[]'](1));
        self.hist['$[]'](0).$attachCurve(self.exp['$[]'](0));
        self.hist['$[]'](1).$attachCurve(self.exp['$[]'](1));
        self.exp['$[]'](0).$attachSummary();
        self.exp['$[]'](1).$attachSummary();
        self.hist['$[]'](0).$attachSummary();
        self.hist['$[]'](1).$attachSummary();
        self.ratioExpAxis = [(1)['$-'](self.graphExp.$marg()['$[]']("b")['$/'](self.graphExp.$dim()['$[]']("h"))), 0.2];
        self.yExpAxis = [self.ratioExpAxis['$[]'](0)['$*'](self.graphExp.$dim()['$[]']("h")), self.ratioExpAxis['$[]'](1)['$*'](self.graphExp.$dim()['$[]']("h"))];
        self.exp['$[]'](0).$attachExpAxis(self.ratioExpAxis['$[]'](0));
        self.exp['$[]'](1).$attachExpAxis(self.ratioExpAxis['$[]'](1));
        self.n01 = $scope.get('Distribution').$new("normal", [0, 1]);
        self.$setAlpha(0.05);
        self.$setStatMode("none");
        self['$isModeHidden?']();
        self.$setTransf();
        self.$reset();
        $a = [[], []], self.x = $a[0], self.y = $a[1];
        self.aep = [];
        $a = [[], [], [], []], self.w = $a[0], self.h = $a[1], self.wX = $a[2], self.hY = $a[3];
        self.style = $hash2(["fp", "sp", "fl", "sl", "fr", "sr"], {"fp": "#FFF", "sp": "#000000", "fl": "#FFF", "sl": "#000000", "fr": "rgba(100,100,255,0.8)", "sr": "#000000"});
        self.$setMLevel(3, "set");
        return self.$setN(1);
      };

      def.$reset = function(curs) {
        var $a, $b, $c, TMP_35, self = this;

        if (curs == null) {
          curs = [0]
        }
        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          curs['$<<'](1)};
        (($a = [(function() {if ((($c = self.transf) !== nil && (!$c.$$is_boolean || $c == true))) {
          return ["curve0", "curve1"]
          } else {
          return ["curve0"]
        }; return nil; })()]), $b = self.graphExp, $b['$active='].apply($b, $a), $a[$a.length-1]);
        self.graphExp.$update();
        self.plotExp.$update();
        ($a = ($b = curs).$each, $a.$$p = (TMP_35 = function(cur){var self = TMP_35.$$s || this;
          if (self.hist == null) self.hist = nil;
          if (self.exp == null) self.exp = nil;
if (cur == null) cur = nil;
        self.hist['$[]'](cur).$reset();
          self.exp['$[]'](cur).$draw();
          self.hist['$[]'](cur).$drawCurve();
          return self.hist['$[]'](cur).$draw();}, TMP_35.$$s = self, TMP_35), $a).call($b);
        self.plotHist.$update();
        self.$setCurHist((function() {if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          return 1
          } else {
          return 0
        }; return nil; })());
        self.$setTCL();
        self.$updateTCL(false);
        return self.$updateVisible();
      };

      def.$setTCL = function() {
        var $a, $b, self = this, $case = nil;

        if ((($a = self.checkTCL) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.checkTCL = $scope.get('Curve').$new();
          (($a = [$hash2(["close", "stroke", "fill", "thickness"], {"close": true, "stroke": "#000", "fill": "rgba(100,200,255,0.5)", "thickness": 5})]), $b = self.checkTCL, $b['$style='].apply($b, $a), $a[$a.length-1]);
          self.plotHist.$addChild(self.checkTCL);
        };
        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          return (function() {$case = self.transf['$[]']("name");if ("mean"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [self.exp['$[]'](0).$distrib().$mean(), Math.sqrt(self.exp['$[]'](0).$distrib().$variance()['$/'](self.n))])}else if ("stdMean"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [0, 1])}else if ("sum"['$===']($case)) {return self.checkTCL.$setDistrib("normal", [self.exp['$[]'](0).$distrib().$mean()['$*'](self.n), Math.sqrt(self.exp['$[]'](0).$distrib().$variance()['$*'](self.n))])}else { return nil }})()
          } else {
          return nil
        };
      };

      def.$updateTCL = function(state) {
        var $a, $b, self = this;

        if (state == null) {
          state = true
        }
        if ((($a = ($b = self.transf, $b !== false && $b !== nil ?(["mean", "sum", "stdMean"]['$include?'](self.transf['$[]']("name"))) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          state = false
        };
        if (state !== false && state !== nil) {
          self.$setTCL();
          self.checkTCL.$draw();};
        return self.checkTCL.shape.visible=state;
      };

      def.$setDistrib = function(name, params, cur) {
        var $a, $b, self = this, to_set = nil, $case = nil;

        if (name == null) {
          name = "normal"
        }
        if (params == null) {
          params = nil
        }
        if (cur == null) {
          cur = 0
        }
        to_set = true;
        $case = name;if ("discreteUniform"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [1, 6, 1]
        }}else if ("bernoulli"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [0.15]
        }}else if ("binomial"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [5, 0.15]
        }}else if ("birthday"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [365, 50]
        }}else if ("uniform"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [0, 1]
        }}else if ("stdNormal"['$===']($case)) {name = "normal";
        if (params !== false && params !== nil) {
          } else {
          params = [0, 1]
        };}else if ("normal"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [2, 0.5]
        }}else if ("t"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [10]
        }}else if ("chi2"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [10]
        }}else if ("exp"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [1]
        }}else if ("cauchy"['$===']($case)) {if (params !== false && params !== nil) {
          } else {
          params = [0, 1]
        }}else if ("saljus"['$===']($case)) {self.$setDistribAs($scope.get('Distribution').$new("exp", [1], $hash2(["name", "args"], {"name": "locationScale", "args": [90, 10]})));
        to_set = false;};
        if (to_set !== false && to_set !== nil) {
          self.exp['$[]'](cur).$setDistrib(name, params)};
        if ((($a = ($b = self.transf, $b !== false && $b !== nil ?cur['$=='](0) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.$setTransf(self.transf['$[]']("name"))
          } else {
          return nil
        };
      };

      def.$setDistribAs = function(dist, cur) {
        var self = this;

        if (cur == null) {
          cur = 0
        }
        return self.exp['$[]'](cur).$setDistribAs(dist);
      };

      def.$setTransfDistrib = function(dist, transf, cur) {
        var self = this;

        if (cur == null) {
          cur = 0
        }
        return self.exp['$[]'](cur).$setDistribAsTransf(transf, dist);
      };

      def.$addXY = function(n, cur) {
        var $a, self = this, xy = nil;

        if (n == null) {
          n = 1
        }
        if (cur == null) {
          cur = 0
        }
        xy = self.exp['$[]'](cur).$xy(n);
        return $a = [xy['$[]']("x"), xy['$[]']("y")], self.x['$[]='](cur, $a[0]), self.y['$[]='](cur, $a[1]);
      };

      def.$setN = function(n) {
        var $a, self = this;

        self.n = n;
        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          self.$setTransf(self.transf['$[]']("name"))};
        return self.$setNbSim();
      };

      def.$setStatMode = function(transf) {
        var self = this;

        self.statMode = ((function() {if (transf['$==']("meanIC")) {
          return "ic"
          } else {
          return "none"
        }; return nil; })());
        return self['$isModeHidden?']();
      };

      def.$setAlpha = function(alpha) {
        var self = this;

        return self.alpha = alpha;
      };

      def.$setMLevel = function(val, mode) {
        var $a, $b, self = this;

        if (val == null) {
          val = 3
        }
        if (mode == null) {
          mode = "inc"
        }
        if ((($a = (($b = mode['$==']("inc")) ? val['$=='](0) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.mLevel};
        if ((($a = self.mLevels) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          self.mLevels = [1, 3, 5, 10, 30, 100, 1000, 3000]
        };
        self.mLevel = ((function() {if (mode['$==']("inc")) {
          return self.mLevel
          } else {
          return 0
        }; return nil; })())['$+'](val);
        if (self.mLevel['$<'](0)) {
          self.mLevel = 0};
        if (self.mLevel['$>'](self.mLevels.$length()['$-'](1))) {
          self.mLevel = self.mLevels.$length()['$-'](1)};
        return self.$setNbSim();
      };

      def.$setNbSim = function() {
        var self = this;

        return self.nbSim = [self.n['$*'](self.mLevels['$[]'](self.mLevel)), cqlsAEP.m.nbSimMax].$min();
      };

      def.$setTransf = function(transf) {
        var $a, self = this, dist0 = nil, $case = nil, name = nil, params = nil;

        if (transf == null) {
          transf = nil
        }
        self.transf = transf;
        if (self.transf['$==']("none")) {
          self.transf = nil};
        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          if (self.n['$=='](1)) {
            if ((($a = self.nold) !== nil && (!$a.$$is_boolean || $a == true))) {
              } else {
              self.nold = 10
            };
            self.n = self.nold;
            self.$setNbSim();};
          if ((($a = self.transfList) !== nil && (!$a.$$is_boolean || $a == true))) {
            } else {
            self.$initTransfList()
          };
          self.transf = self.transfList['$[]'](transf);
          self.transf['$[]=']("name", transf);
          self.transf['$[]=']("origDist", dist0 = self.exp['$[]'](0).$distrib());
          return (function() {$case = self.transf['$[]']("name");if ("sum"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("bernoulli")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib("binomial", [self.n, dist0.$mean()], 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "normal", params = [self.n['$*'](dist0.$mean()), Math.sqrt(dist0.$variance()['$*'](self.n))], 1);
          } else if (dist0.$type()['$==']("disc")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          } else if (self.n['$>='](30)) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [self.n['$*'](dist0.$mean()), Math.sqrt(dist0.$variance()['$*'](self.n))], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          };}else if ("mean"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("bernoulli")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistribAs($scope.get('Distribution').$new("binomial", [self.n, dist0.$mean()], $hash2(["name", "args"], {"name": "locationScale", "args": [0, (1)['$/'](self.n)]})), 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "normal", params = [dist0.$mean(), Math.sqrt(dist0.$variance()['$/'](self.n))], 1);
          } else if (self.exp['$[]'](0).$distrib().$name()['$==']("cauchy")) {
            self.transf['$[]=']("dist", "exact2");
            return self.$setDistrib(name = "cauchy", params = [0, 1], 1);
          } else if (dist0.$type()['$==']("disc")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          } else if (self.n['$>='](30)) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [dist0.$mean(), Math.sqrt(dist0.$variance()['$/'](self.n))], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setTransfDistrib(dist0, self.transf, 1);
          };}else if ("stdMean"['$===']($case)) {self.transf['$[]=']("args", [dist0.$mean()]);
          if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            self.transf['$[]=']("dist", "exact");
            return self.$setDistrib(name = "t", params = [self.n['$-'](1)], 1);
          } else if (self.n['$>='](30)) {
            self.transf['$[]=']("dist", "approx");
            return self.$setDistrib(name = "normal", params = [0, 1], 1);
            } else {
            self.transf['$[]=']("dist", "xylim");
            return self.$setDistrib(name = "normal", params = [0, 1], 1);
          };}else if ("sumOfSq"['$===']($case)) {self.transf['$[]=']("args", [self.n]);
          self.transf['$[]=']("dist", "exact2");
          if (self.exp['$[]'](0).$distrib().$name()['$==']("normal")) {
            return self.$setDistrib("chi2", [self.n], 1)
            } else {
            return self.$setTransfDistrib(dist0, self.transf, 1)
          };}else if ("locationScale"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1];
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("args", [dist0.$mean()['$-@']()['$/'](Math.sqrt(dist0.$variance())), (1)['$/'](Math.sqrt(dist0.$variance()))]);
          return self.$setTransfDistrib(dist0, self.transf, 1);}else if ("square"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1];
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("args", []);
          return self.$setTransfDistrib(dist0, self.transf, 1);}else if ("center"['$===']($case)) {$a = [self.n, 1], self.nold = $a[0], self.n = $a[1];
          self.transf['$[]=']("dist", "exact");
          self.transf['$[]=']("transf", "locationScale");
          self.transf['$[]=']("args", [dist0.$mean()['$-@'](), 1]);
          return self.$setTransfDistrib(dist0, $hash2(["name", "args"], {"name": self.transf['$[]']("transf"), "args": self.transf['$[]']("args")}), 1);}else { return nil }})();
          } else {
          self.nold = self.n;
          return self.n = 1;
        };
      };

      def.$animMode = function() {
        var $a, self = this;

        cqlsAEP.i.anim=cqlsAEP.f.getValue("animMode");
        cqlsAEP.i.prior=cqlsAEP.f.getValue("priorMode");
        if ((($a = cqlsAEP.i.anim) !== nil && (!$a.$$is_boolean || $a == true))) {
          if ((($a = cqlsAEP.i.prior) !== nil && (!$a.$$is_boolean || $a == true))) {
            return "prior"
            } else {
            return "normal"
          }
          } else {
          return "fast"
        };
      };

      def.$transfMode = function() {
        var $a, self = this;

        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.transf['$[]']("mode")
          } else {
          return "none"
        };
      };

      def.$initTransfList = function() {
        var self = this;

        return self.transfList = $hash2(["sum", "mean", "stdMean", "sumOfSq", "locationScale", "square", "addition", "center"], {"sum": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "mean": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "stdMean": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "sumOfSq": $hash2(["args", "mode"], {"args": [], "mode": "sample"}), "locationScale": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "square": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "addition": $hash2(["args", "mode"], {"args": [], "mode": "all"}), "center": $hash2(["args", "mode"], {"args": [], "mode": "all"})});
      };

      def.$applyTransfByValue = function(v) {
        var $a, $b, self = this;

        return ($a = self.$method((((($b = self.transf['$[]']("transf")) !== false && $b !== nil) ? $b : self.transf['$[]']("name")))['$+']("_transf"))).$call.apply($a, [v].concat(self.transf['$[]']("args")));
      };

      def.$applyTransfByIndex = function(inds, v) {
        var $a, $b, self = this;

        return ($a = self.$method((((($b = self.transf['$[]']("transf")) !== false && $b !== nil) ? $b : self.transf['$[]']("name")))['$+']("_transf_by_index"))).$call.apply($a, [inds, v].concat(self.transf['$[]']("args")));
      };

      def.$sum_transf = function(v) {
        var $a, $b, TMP_36, self = this;

        return ($a = ($b = v).$inject, $a.$$p = (TMP_36 = function(e, v2){var self = TMP_36.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2)}, TMP_36.$$s = self, TMP_36), $a).call($b, 0);
      };

      def.$sum_transf_by_index = function(inds, v) {
        var $a, $b, TMP_37, self = this;

        return ($a = ($b = inds).$inject, $a.$$p = (TMP_37 = function(e, i){var self = TMP_37.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i))}, TMP_37.$$s = self, TMP_37), $a).call($b, 0);
      };

      def.$mean_transf = function(v) {
        var $a, $b, TMP_38, self = this;

        return (($a = ($b = v).$inject, $a.$$p = (TMP_38 = function(e, v2){var self = TMP_38.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2)}, TMP_38.$$s = self, TMP_38), $a).call($b, 0))['$/'](self.n);
      };

      def.$mean_transf_by_index = function(inds, v) {
        var $a, $b, TMP_39, self = this;

        return (($a = ($b = inds).$inject, $a.$$p = (TMP_39 = function(e, i){var self = TMP_39.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i))}, TMP_39.$$s = self, TMP_39), $a).call($b, 0))['$/'](self.n);
      };

      def.$stdMean_transf = function(v, mu) {
        var $a, $b, TMP_40, $c, TMP_41, self = this, m = nil, m2 = nil;

        m = (($a = ($b = v).$inject, $a.$$p = (TMP_40 = function(e, v2){var self = TMP_40.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2)}, TMP_40.$$s = self, TMP_40), $a).call($b, 0))['$/'](self.n);
        m2 = (($a = ($c = v).$inject, $a.$$p = (TMP_41 = function(e, v2){var self = TMP_41.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2['$**'](2))}, TMP_41.$$s = self, TMP_41), $a).call($c, 0))['$/'](self.n);
        return (m['$-'](mu))['$/'](Math.sqrt((m2['$-'](m['$**'](2)))/self.n['$-'](1)));
      };

      def.$stdMean_transf_by_index = function(inds, v, mu) {
        var $a, $b, TMP_42, $c, TMP_43, self = this, m = nil, m2 = nil;

        m = (($a = ($b = inds).$inject, $a.$$p = (TMP_42 = function(e, i){var self = TMP_42.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i))}, TMP_42.$$s = self, TMP_42), $a).call($b, 0))['$/'](self.n);
        m2 = ($a = ($c = inds).$inject, $a.$$p = (TMP_43 = function(e, i){var self = TMP_43.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i)['$**'](2))}, TMP_43.$$s = self, TMP_43), $a).call($c, 0)['$/'](self.n);
        return (m['$-'](mu))['$/'](Math.sqrt((m2['$-'](m['$**'](2)))/self.n['$-'](1)));
      };

      def.$sumOfSq_transf = function(v) {
        var $a, $b, TMP_44, self = this, m = nil, s = nil;

        $a = [self.transf['$[]']("origDist").$mean(), self.transf['$[]']("origDist").$stdDev()], m = $a[0], s = $a[1];
        return ($a = ($b = v).$inject, $a.$$p = (TMP_44 = function(e, v2){var self = TMP_44.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](((v2['$-'](m))['$/'](s))['$**'](2))}, TMP_44.$$s = self, TMP_44), $a).call($b, 0);
      };

      def.$sumOfSq_transf_by_index = function(inds, v) {
        var $a, $b, TMP_45, self = this, m = nil, s = nil;

        $a = [self.transf['$[]']("origDist").$mean(), self.transf['$[]']("origDist").$stdDev()], m = $a[0], s = $a[1];
        return ($a = ($b = inds).$inject, $a.$$p = (TMP_45 = function(e, i){var self = TMP_45.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](((v['$[]'](i)['$-'](m))['$/'](s))['$**'](2))}, TMP_45.$$s = self, TMP_45), $a).call($b, 0);
      };

      def.$seMean_transf = function(v) {
        var $a, $b, TMP_46, $c, TMP_47, self = this, m = nil, m2 = nil;

        m = (($a = ($b = v).$inject, $a.$$p = (TMP_46 = function(e, v2){var self = TMP_46.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2)}, TMP_46.$$s = self, TMP_46), $a).call($b, 0))['$/'](self.n);
        m2 = (($a = ($c = v).$inject, $a.$$p = (TMP_47 = function(e, v2){var self = TMP_47.$$s || this;
if (e == null) e = nil;if (v2 == null) v2 = nil;
        return e = e['$+'](v2['$**'](2))}, TMP_47.$$s = self, TMP_47), $a).call($c, 0))['$/'](self.n);
        return Math.sqrt((m2['$-'](m['$**'](2)))/self.n['$-'](1));
      };

      def.$seMean_transf_by_index = function(inds, v) {
        var $a, $b, TMP_48, $c, TMP_49, self = this, m = nil, m2 = nil;

        m = (($a = ($b = inds).$inject, $a.$$p = (TMP_48 = function(e, i){var self = TMP_48.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i))}, TMP_48.$$s = self, TMP_48), $a).call($b, 0))['$/'](self.n);
        m2 = (($a = ($c = inds).$inject, $a.$$p = (TMP_49 = function(e, i){var self = TMP_49.$$s || this;
if (e == null) e = nil;if (i == null) i = nil;
        return e = e['$+'](v['$[]'](i)['$**'](2))}, TMP_49.$$s = self, TMP_49), $a).call($c, 0))['$/'](self.n);
        return Math.sqrt((m2['$-'](m['$**'](2)))/self.n['$-'](1));
      };

      def.$locationScale_transf = function(v) {
        var $a, $b, TMP_50, self = this;

        return ($a = ($b = v).$map, $a.$$p = (TMP_50 = function(e){var self = TMP_50.$$s || this;
          if (self.transf == null) self.transf = nil;
if (e == null) e = nil;
        return self.transf['$[]']("args")['$[]'](0)['$+'](e['$*'](self.transf['$[]']("args")['$[]'](1)))}, TMP_50.$$s = self, TMP_50), $a).call($b);
      };

      def.$locationScale_transf_by_index = function(inds, v) {
        var $a, $b, TMP_51, self = this;

        return ($a = ($b = inds).$map, $a.$$p = (TMP_51 = function(i){var self = TMP_51.$$s || this;
          if (self.transf == null) self.transf = nil;
if (i == null) i = nil;
        return self.transf['$[]']("args")['$[]'](0)['$+'](v['$[]'](i)['$*'](self.transf['$[]']("args")['$[]'](1)))}, TMP_51.$$s = self, TMP_51), $a).call($b);
      };

      def.$square_transf = function(v) {
        var $a, $b, TMP_52, self = this;

        return ($a = ($b = v).$map, $a.$$p = (TMP_52 = function(e){var self = TMP_52.$$s || this;
if (e == null) e = nil;
        return e['$**'](2)}, TMP_52.$$s = self, TMP_52), $a).call($b);
      };

      def.$square_transf_by_index = function(inds, v) {
        var $a, $b, TMP_53, self = this;

        return ($a = ($b = inds).$map, $a.$$p = (TMP_53 = function(i){var self = TMP_53.$$s || this;
if (i == null) i = nil;
        return v['$[]'](i)['$**'](2)}, TMP_53.$$s = self, TMP_53), $a).call($b);
      };

      def.$setCurHist = function(ind) {
        var self = this;

        if (ind == null) {
          ind = 0
        }
        self.curIndHist = ind;
        self.histCur = self.hist['$[]'](self.curIndHist);
        return self.expCur = self.exp['$[]'](self.curIndHist);
      };

      def.$drawHist = function() {
        var self = this;

        return nil;
      };

      def.$allowLevelChange = function(state) {
        var self = this;

        cqlsAEP.i.allowLevelChange=state;
        if (state !== false && state !== nil) {
          return self.histCur.$acceptLevelNext()
          } else {
          return nil
        };
      };

      def.$transitionInitTransf = function(o, t) {
        var $a, $b, TMP_54, $c, TMP_55, $d, TMP_56, $e, TMP_57, $f, TMP_58, $g, TMP_59, $h, TMP_60, self = this, q = nil, mu = nil, opdf = nil, tpdf = nil;

        if (o == null) {
          o = 0
        }
        if (t == null) {
          t = 1
        }
        if (self.$transfMode()['$==']("sample")) {
          self.ind = [];
          ($a = ($b = ($range(0, (self.x['$[]'](o).$length()['$/'](self.n)), true))).$each, $a.$$p = (TMP_54 = function(i){var self = TMP_54.$$s || this;
            if (self.ind == null) self.ind = nil;
if (i == null) i = nil;
          return self.ind['$<<']([])}, TMP_54.$$s = self, TMP_54), $a).call($b);
          ($a = ($c = ($range(0, self.x['$[]'](o).$length(), true))).$each, $a.$$p = (TMP_55 = function(i){var self = TMP_55.$$s || this;
            if (self.ind == null) self.ind = nil;
            if (self.n == null) self.n = nil;
if (i == null) i = nil;
          return self.ind['$[]']((i['$/'](self.n)).$floor())['$<<'](i)}, TMP_55.$$s = self, TMP_55), $a).call($c);
          self.x['$[]='](t, [0]['$*']((self.x['$[]'](o).$length()['$/'](self.n))));
          if (self.statMode['$==']("ic")) {
            $a = [[0]['$*']((self.x['$[]'](t).$length())), [0]['$*']((self.x['$[]'](t).$length())), 0, self.n01.$quantile((1)['$-'](self.alpha['$/'](2))), self.exp['$[]'](t).$distrib().$mean()], self.icSide = $a[0], self.icGood = $a[1], self.cptIC = $a[2], q = $a[3], mu = $a[4]};
          self.col = [];
          ($a = ($d = self.ind).$each_with_index, $a.$$p = (TMP_56 = function(s, i){var self = TMP_56.$$s || this, $a, $b;
            if (self.x == null) self.x = nil;
            if (self.col == null) self.col = nil;
            if (self.statMode == null) self.statMode = nil;
            if (self.icSide == null) self.icSide = nil;
            if (self.icGood == null) self.icGood = nil;
            if (self.cptIC == null) self.cptIC = nil;
if (s == null) s = nil;if (i == null) i = nil;
          self.x['$[]'](t)['$[]='](i, self.$applyTransfByIndex(s, self.x['$[]'](o)));
            self.col['$[]='](i, [(Math.random()*256).$floor(), (Math.random()*256).$floor(), (Math.random()*256).$floor(), 0.8]);
            if (self.statMode['$==']("ic")) {
              self.icSide['$[]='](i, q['$*'](self.$seMean_transf_by_index(s, self.x['$[]'](o))));
              if ((($a = ($b = (self.x['$[]'](t)['$[]'](i)['$-'](self.icSide['$[]'](i))['$<='](mu)), $b !== false && $b !== nil ?(mu['$<='](self.x['$[]'](t)['$[]'](i)['$+'](self.icSide['$[]'](i)))) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
                self.icGood['$[]='](i, 1)};
              return self.cptIC = self.cptIC['$+'](self.icGood['$[]'](i));
              } else {
              return nil
            };}, TMP_56.$$s = self, TMP_56), $a).call($d);
          return self.y['$[]='](t, self.exp['$[]'](t).$y(self.x['$[]'](t)));
        } else if (self.$transfMode()['$==']("all")) {
          self.ind = ($a = ($e = ($range(0, self.x['$[]'](o).$length(), true))).$map, $a.$$p = (TMP_57 = function(i){var self = TMP_57.$$s || this;
if (i == null) i = nil;
          return [i]}, TMP_57.$$s = self, TMP_57), $a).call($e);
          self.x['$[]='](t, self.$applyTransfByValue(self.x['$[]'](o)));
          self.col = [[0, 0, 0, 1]]['$*']((self.x['$[]'](t).$length()));
          self.y['$[]='](t, self.exp['$[]'](t).$y(self.x['$[]'](t)));
          opdf = ($a = ($f = self.exp['$[]'](o).$distrib().$pdf(self.x['$[]'](o))).$map, $a.$$p = (TMP_58 = function(e){var self = TMP_58.$$s || this;
            if (self.exp == null) self.exp = nil;
if (e == null) e = nil;
          return e['$/'](self.exp['$[]'](o).$distrib().$step())}, TMP_58.$$s = self, TMP_58), $a).call($f);
          tpdf = ($a = ($g = self.exp['$[]'](t).$distrib().$pdf(self.x['$[]'](t))).$map, $a.$$p = (TMP_59 = function(e){var self = TMP_59.$$s || this;
            if (self.exp == null) self.exp = nil;
if (e == null) e = nil;
          return e['$/'](self.exp['$[]'](t).$distrib().$step())}, TMP_59.$$s = self, TMP_59), $a).call($g);
          return self.y['$[]='](t, ($a = ($h = ($range(0, self.x['$[]'](o).$length(), true))).$map, $a.$$p = (TMP_60 = function(i){var self = TMP_60.$$s || this;
            if (self.y == null) self.y = nil;
if (i == null) i = nil;
          return (self.y['$[]'](o)['$[]'](i))['$/'](opdf['$[]'](i))['$*'](tpdf['$[]'](i))}, TMP_60.$$s = self, TMP_60), $a).call($h));
          } else {
          return nil
        };
      };

      def.$transitionInitHist = function(cur, mode) {
        var $a, self = this;

        if (mode == null) {
          mode = "normal"
        }
        self.$allowLevelChange(false);
        self.hist['$[]'](cur).$updateHistAEP(self.x['$[]'](cur), mode);
        self.aep['$[]='](cur, self.hist['$[]'](cur).$aep());
        $a = [self.aep['$[]'](cur)['$[]']("step"), (1)['$/'](self.aep['$[]'](cur)['$[]']("nbTot").$to_f())['$/'](self.aep['$[]'](cur)['$[]']("step"))], self.w['$[]='](cur, $a[0]), self.h['$[]='](cur, $a[1]);
        return $a = [self.graphHist.$to_X(self.w['$[]'](cur))['$-'](self.graphHist.$to_X(0)), self.graphHist.$to_Y(0)['$-'](self.graphHist.$to_Y(self.h['$[]'](cur)))], self.wX['$[]='](cur, $a[0]), self.hY['$[]='](cur, $a[1]);
      };

      def.$transitionInitPts = function(cur) {
        var $a, $b, TMP_61, self = this;

        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_61 = function(i){var self = TMP_61.$$s || this;
          if (self.style == null) self.style = nil;
          if (self.hist == null) self.hist = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        
					//draw points
					cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(self.style['$[]']("fp")).drawCircle(0,0,cqlsAEP.i.ptSize);
					//tweens for points
					cqlsAEP.tweens.pt[i]=createjs.Tween.get(cqlsAEP.actors.pt[i],{override:true});
				;
          if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            
						//draw lines
						cqlsAEP.actors.line[i].graphics.c().s(self.style['$[]']("sl")).f(self.style['$[]']("fl"))
						.drawRect(0,0,self.wX['$[]'](cur),0);
						cqlsAEP.actors.line[i].regX=self.wX['$[]'](cur)/2.0;
						//tweens for lines
						cqlsAEP.tweens.line[i]=createjs.Tween.get(cqlsAEP.actors.line[i],{override:true});
					;
            } else {
            return nil
          };}, TMP_61.$$s = self, TMP_61), $a).call($b);
      };

      def.$transitionInitPtsTransf = function(cur) {
        var $a, $b, TMP_62, $c, TMP_64, self = this;

        if (self.transf['$[]']("mode")['$==']("sample")) {
          } else {
          return nil
        };
        if (cur['$=='](0)) {
          return ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_62 = function(s, i2){var self = TMP_62.$$s || this, $a, $b, TMP_63, col = nil;
            if (self.col == null) self.col = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
          col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
            return ($a = ($b = s).$each, $a.$$p = (TMP_63 = function(i){var self = TMP_63.$$s || this;
              if (self.style == null) self.style = nil;
              if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
            
							cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(col).drawCircle(0,0,cqlsAEP.i.ptSize);
							cqlsAEP.actors.line[i].graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
						;}, TMP_63.$$s = self, TMP_63), $a).call($b);}, TMP_62.$$s = self, TMP_62), $a).call($b)
          } else {
          return ($a = ($c = ($range(0, self.x['$[]'](cur).$length(), true))).$each_with_index, $a.$$p = (TMP_64 = function(i){var self = TMP_64.$$s || this, col = nil;
            if (self.col == null) self.col = nil;
            if (self.style == null) self.style = nil;
            if (self.hist == null) self.hist = nil;
            if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
          col = "rgba(" + (self.col['$[]'](i)['$[]'](0)) + "," + (self.col['$[]'](i)['$[]'](1)) + "," + (self.col['$[]'](i)['$[]'](2)) + "," + (self.col['$[]'](i)['$[]'](3)) + ")";
            
						cqlsAEP.actors.pt[i].graphics.c().s(self.style['$[]']("sp")).f(col).drawCircle(0,0,cqlsAEP.i.ptSize);
					;
            if (self.hist['$[]'](cur).$type()['$==']("disc")) {
              
							//cqlsAEP.actors.line[i].graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
							cqlsAEP.tweens.line[i].call(function(tween) {
					 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](cur),2);
					 		})
					;
              } else {
              return nil
            };}, TMP_64.$$s = self, TMP_64), $a).call($c)
        };
      };

      def.$transitionInitTime = function() {
        var self = this;

        return self.time = 0;
      };

      def.$transitionInitExpRects = function(cur) {
        var $a, $b, TMP_65, self = this, scale = nil;

        if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
          scale = (self.graphExp.$dim()['$[]']("h")['$*'](0.2))['$/']((self.x['$[]'](cur).$length()));
          if (scale['$>'](1)) {
            scale = 1};};
        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_65 = function(i){var self = TMP_65.$$s || this, y = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.hist == null) self.hist = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        y = self.yExpAxis['$[]'](0)['$-'](((function() {if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            return (i['$*'](scale))
            } else {
            return 0
          }; return nil; })()));
          
					//draw rect first
					cqlsAEP.actors.rect[i].x=self.graphExp.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i));cqlsAEP.actors.rect[i].y=y;
					cqlsAEP.actors.rect[i].regY=self.hY['$[]'](cur)['$/'](2);
					cqlsAEP.actors.rect[i].graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					cqlsAEP.tweens.rect[i]=createjs.Tween.get(cqlsAEP.actors.rect[i],{override:true});
				;}, TMP_65.$$s = self, TMP_65), $a).call($b);
      };

      def.$transitionInitRects = function(cur) {
        var $a, $b, TMP_66, self = this;

        return ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_66 = function(i){var self = TMP_66.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.plotHist == null) self.plotHist = nil;
          if (self.hY == null) self.hY = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        
					//draw rect first
					cqlsAEP.actors.rect[i].x=self.graphHist.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i));cqlsAEP.actors.rect[i].y=self.plotHist.$dim()['$[]']("y");
					cqlsAEP.actors.rect[i].regY=self.hY['$[]'](cur)['$/'](2);
					cqlsAEP.actors.rect[i].graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					cqlsAEP.tweens.rect[i]=createjs.Tween.get(cqlsAEP.actors.rect[i],{override:true});
				;}, TMP_66.$$s = self, TMP_66), $a).call($b);
      };

      def.$transitionDrawPts = function(cur, wait) {
        var $a, $b, TMP_67, self = this, scale = nil;

        if (wait == null) {
          wait = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
          scale = (self.graphExp.$dim()['$[]']("h")['$*'](0.2))['$/']((self.x['$[]'](cur).$length()));
          if (scale['$>'](1)) {
            scale = 1};
          if (cur['$=='](0)) {
            self.remember = $hash2(["lag"], {"lag": wait['$/'](self.x['$[]'](cur).$length())})};};
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_67 = function(i){var self = TMP_67.$$s || this, $a, $b, $c, y = nil, wait2 = nil;
          if (self.modeHidden == null) self.modeHidden = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
          if (self.transf == null) self.transf = nil;
          if (self.remember == null) self.remember = nil;
          if (self.x == null) self.x = nil;
if (i == null) i = nil;
        y = (function() {if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
            return self.yExpAxis['$[]'](0)
            } else {
            return self.graphExp.$to_Y(self.y['$[]'](cur)['$[]'](i))
          }; return nil; })();
          if ((($a = ($b = self.modeHidden, $b !== false && $b !== nil ?self.hist['$[]'](cur).$type()['$==']("disc") : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            y = y['$-'](i['$*'](scale))};
          wait2 = wait;
          if ((($a = ($b = ($c = self.modeHidden, $c !== false && $c !== nil ?cur['$=='](0) : $c), $b !== false && $b !== nil ?self.transf : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            wait2 = wait2['$-'](i['$*'](self.remember['$[]']("lag")))};
          
					cqlsAEP.tweens.pt[i].to({x:self.graphExp.$to_X(self.x['$[]'](cur)['$[]'](i)),y:y})
					.set({visible:true})
					.wait(wait2)
				;
          if ((($a = (($b = self.hist['$[]'](cur).$type()['$==']("disc")) ? self.modeHidden['$!']() : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            
						cqlsAEP.tweens.line[i].to({x:self.graphExp.$to_X(self.x['$[]'](cur)['$[]'](i)),y:self.graphExp.$to_Y(self.y['$[]'](cur)['$[]'](i))})
						.set({visible:true})
						.wait(wait);
					;
            } else {
            return nil
          };}, TMP_67.$$s = self, TMP_67), $a).call($b);
        return self.time = self.time['$+'](wait);
      };

      def.$transitionPtsTransf = function(t, merge, wait) {
        var $a, $b, TMP_68, self = this, scale = nil;

        if (t == null) {
          t = 1
        }
        if (merge == null) {
          merge = (1500)['$*'](cqlsAEP.i.scaleTime)
        }
        if (wait == null) {
          wait = (500)['$*'](cqlsAEP.i.scaleTime)
        }
        if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
          scale = (self.graphExp.$dim()['$[]']("h")['$*'](0.2))['$/']((self.ind.$length()));
          if (scale['$>'](1)) {
            scale = 1};};
        ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_68 = function(s, i2){var self = TMP_68.$$s || this, $a, $b, TMP_69, col = nil, y = nil;
          if (self.col == null) self.col = nil;
          if (self.modeHidden == null) self.modeHidden = nil;
          if (self.yExpAxis == null) self.yExpAxis = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
        col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
          y = (function() {if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
            return self.yExpAxis['$[]'](1)
            } else {
            return self.graphExp.$to_Y(self.y['$[]'](t)['$[]'](i2))
          }; return nil; })();
          if ((($a = ($b = self.modeHidden, $b !== false && $b !== nil ?self.hist['$[]'](t).$type()['$==']("disc") : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
            y = y['$-'](i2['$*'](scale))};
          return ($a = ($b = s).$each, $a.$$p = (TMP_69 = function(i){var self = TMP_69.$$s || this, $a, $b, $c, wait2 = nil;
            if (self.modeHidden == null) self.modeHidden = nil;
            if (self.n == null) self.n = nil;
            if (self.remember == null) self.remember = nil;
            if (self.graphExp == null) self.graphExp = nil;
            if (self.x == null) self.x = nil;
            if (self.transf == null) self.transf = nil;
            if (self.hist == null) self.hist = nil;
            if (self.wX == null) self.wX = nil;
            if (self.style == null) self.style = nil;
            if (self.y == null) self.y = nil;
if (i == null) i = nil;
          wait2 = wait;
            if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
              wait2 = wait2['$-']((self.n['$-'](i))['$*'](self.remember['$[]']("lag")))};
            
						cqlsAEP.tweens.pt[i].to({x:self.graphExp.$to_X(self.x['$[]'](t)['$[]'](i2)),y:y},merge)
						if(self.modeHidden) cqlsAEP.tweens.pt[i].to({y:self.graphExp.$to_Y(0)},merge)
						cqlsAEP.tweens.pt[i].wait(wait2).set({visible:false})
						if(($a = ($b = ($c = self.transf, $c !== false && $c !== nil ?self.hist['$[]'](0).$type()['$==']("disc") : $c), $b !== false && $b !== nil ?self.hist['$[]'](1).$type()['$==']("disc") : $b), $a !== false && $a !== nil ?self.modeHidden['$!']() : $a)) {
					 		cqlsAEP.tweens.line[i].call(function(tween) {
					 			tween._target.regX=self.wX['$[]'](t)/2.0;
					 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,self.wX['$[]'](t),2);
					 		})
					 		.to({x:self.graphExp.$to_X(self.x['$[]'](t)['$[]'](i2)),y:self.graphExp.$to_Y(self.y['$[]'](t)['$[]'](i2))},merge)
							.wait(wait).set({visible:false})
					 		//cqlsAEP.tweens.line[i].wait(wait['$+'](merge)).set({visible:false});
						}
					;}, TMP_69.$$s = self, TMP_69), $a).call($b);}, TMP_68.$$s = self, TMP_68), $a).call($b);
        self.time = self.time['$+'](merge['$+'](wait));
        if ((($a = self.modeHidden) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.time = self.time['$+'](merge)
          } else {
          return nil
        };
      };

      def.$transitionFallPts = function(cur, fall, wait) {
        var $a, $b, TMP_70, self = this;

        if (fall == null) {
          fall = (2000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (wait == null) {
          wait = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        cqlsAEP.durations.ptsBeforeFall=self.time;
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_70 = function(i){var self = TMP_70.$$s || this;
          if (self.plotHist == null) self.plotHist = nil;
          if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].to({y:self.plotHist.$dim()['$[]']("y")},fall,createjs.Ease.bounceOut)
					.wait(wait)
				;
          if (self.hist['$[]'](cur).$type()['$==']("disc")) {
            
						cqlsAEP.tweens.line[i].to({y:self.plotHist.$dim()['$[]']("y")},fall,createjs.Ease.bounceOut)
						.wait(wait).set({visible:false});
					;
            } else {
            return nil
          };}, TMP_70.$$s = self, TMP_70), $a).call($b);
        return self.time = self.time['$+'](fall['$+'](wait));
      };

      def.$transitionExpPtsAndRects = function(cur, from, before, fall, after) {
        var $a, $b, TMP_71, self = this;

        if (from == null) {
          from = self.time
        }
        if (before == null) {
          before = (2000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (fall == null) {
          fall = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (after == null) {
          after = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        fall = fall['$+'](self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_71 = function(i){var self = TMP_71.$$s || this;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					//rect start here so wait "from" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(from).set({visible:true})
					.wait(before+i)
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_71.$$s = self, TMP_71), $a).call($b);
        return self.time = self.time['$+'](before['$+'](fall)['$+'](after));
      };

      def.$transitionDrawRectsHidden = function(cur, from, after) {
        var $a, $b, TMP_72, self = this;

        if (from == null) {
          from = self.time
        }
        if (after == null) {
          after = (500)['$*'](cqlsAEP.i.scaleTime)
        }
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_72 = function(i){var self = TMP_72.$$s || this;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.hist == null) self.hist = nil;
          if (self.style == null) self.style = nil;
          if (self.wX == null) self.wX = nil;
if (i == null) i = nil;
        
					 
					cqlsAEP.tweens.pt[i].to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0})
					.wait(after);

					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}
					//redraw rect first
					cqlsAEP.tweens.rect[i].call(function(tween) {
						tween._target.regY=self.hY['$[]'](cur)['$/'](2);
					 	tween._target.graphics.c().f(self.style['$[]']("fr")).s(self.style['$[]']("sr")).drawRect(0,0,self.wX['$[]'](cur),self.hY['$[]'](cur));
					})
					.to({y:self.graphExp.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0})
					.wait(after);

				;}, TMP_72.$$s = self, TMP_72), $a).call($b);
        return self.time = self.time['$+'](after);
      };

      def.$transitionHistPtsAndRectsHidden = function(cur, from, before, fall, after) {
        var $a, $b, TMP_73, self = this;

        if (from == null) {
          from = self.time
        }
        if (before == null) {
          before = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (fall == null) {
          fall = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (after == null) {
          after = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        fall = fall['$+'](self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_73 = function(i){var self = TMP_73.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_73.$$s = self, TMP_73), $a).call($b);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = self.time['$+'](before['$+'](fall)['$+'](after));
      };

      def.$transitionHistPtsAndRects = function(cur, from, before, fall, after) {
        var $a, $b, TMP_74, self = this;

        if (from == null) {
          from = self.time
        }
        if (before == null) {
          before = (2000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (fall == null) {
          fall = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (after == null) {
          after = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        fall = fall['$+'](self.x['$[]'](cur).$length());
        ($a = ($b = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_74 = function(i){var self = TMP_74.$$s || this;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.aep == null) self.aep = nil;
          if (self.hY == null) self.hY = nil;
          if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
        
					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					//rect start here so wait "from" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(from).set({visible:true})
					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}
					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

				;}, TMP_74.$$s = self, TMP_74), $a).call($b);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = self.time['$+'](before['$+'](fall)['$+'](after));
      };

      def.$transitionDrawIC = function(from, wait, pause, before, fall, after) {
        var $a, $b, TMP_75, $c, TMP_76, self = this, cur = nil;

        if (from == null) {
          from = self.time
        }
        if (wait == null) {
          wait = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (pause == null) {
          pause = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (before == null) {
          before = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (fall == null) {
          fall = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        if (after == null) {
          after = (1000)['$*'](cqlsAEP.i.scaleTime)
        }
        ($a = ($b = self.ind).$each_with_index, $a.$$p = (TMP_75 = function(s, i2){var self = TMP_75.$$s || this, col = nil, y = nil, l = nil;
          if (self.col == null) self.col = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.y == null) self.y = nil;
          if (self.icSide == null) self.icSide = nil;
          if (self.hist == null) self.hist = nil;
          if (self.style == null) self.style = nil;
          if (self.x == null) self.x = nil;
          if (self.icGood == null) self.icGood = nil;
if (s == null) s = nil;if (i2 == null) i2 = nil;
        col = "rgba(" + (self.col['$[]'](i2)['$[]'](0)) + "," + (self.col['$[]'](i2)['$[]'](1)) + "," + (self.col['$[]'](i2)['$[]'](2)) + "," + (self.col['$[]'](i2)['$[]'](3)) + ")";
          y = self.graphExp.$to_Y(self.y['$[]'](1)['$[]'](i2));
          l = self.graphExp.$to_X(self.icSide['$[]'](i2))['$-'](self.graphExp.$to_X(0));
          cqlsAEP.tweens.pt[i2].wait(pause);
          if (self.hist['$[]'](1).$type()['$==']("disc")) {
            
						cqlsAEP.tweens.line[i2]
						.call(function(tween) {
				 			tween._target.regX=l;
				 			tween._target.regY=1;
				 			tween._target.graphics.c().s(col).f(self.style['$[]']("fl")).drawRect(0,0,(2)['$*'](l),2);
					 	})
						.wait((2)['$*'](pause))
					 	
					;
            } else {
            
						//draw lines
						cqlsAEP.actors.line[i2].graphics.c().s(col).f(self.style['$[]']("fl"))
						.drawRect(0,0,(2)['$*'](l),2);
						cqlsAEP.actors.line[i2].regX=l;
						cqlsAEP.actors.line[i2].regY=1;
						//tweens for lines
						cqlsAEP.tweens.line[i2]=createjs.Tween.get(cqlsAEP.actors.line[i2],{override:true});
						cqlsAEP.tweens.line[i2].set({visible:false}).wait(from+wait)
						.to({x:self.graphExp.$to_X(self.x['$[]'](1)['$[]'](i2)),y:y})
				 		.set({visible:true}).wait(pause)
				 	;
          };
          if (self.icGood['$[]'](i2)['$=='](0)) {
            
						cqlsAEP.tweens.pt[i2].wait(pause).to({scaleX:2.0,scaleY:2.0},pause) //.to({scaleX:1.0,scaleY:1.0})
						cqlsAEP.tweens.line[i2].to({scaleY:3.0},pause).to({scaleY:1.0})
					;
            } else {
            
						cqlsAEP.tweens.pt[i2].wait((2)['$*'](pause))
						cqlsAEP.tweens.line[i2].wait(pause)
					;
          };}, TMP_75.$$s = self, TMP_75), $a).call($b);
        self.time = self.time['$+']((3)['$*'](pause));
        cur = 1;
        fall = fall['$+'](self.x['$[]'](cur).$length());
        ($a = ($c = ($range(0, self.x['$[]'](cur).$length(), true))).$each, $a.$$p = (TMP_76 = function(i){var self = TMP_76.$$s || this;
          if (self.time == null) self.time = nil;
          if (self.graphExp == null) self.graphExp = nil;
          if (self.aep == null) self.aep = nil;
          if (self.y == null) self.y = nil;
          if (self.hist == null) self.hist = nil;
          if (self.graphHist == null) self.graphHist = nil;
          if (self.hY == null) self.hY = nil;
          if (self.icGood == null) self.icGood = nil;
if (i == null) i = nil;
        
					//rect start here so wait "@time" ms first
					cqlsAEP.tweens.rect[i].set({visible:false})
					.wait(self.time)
					.to({x:self.graphExp.$to_X(self.aep['$[]'](cur)['$[]']("xRect")['$[]'](i)),y:self.graphExp.$to_Y(self.y['$[]'](1)['$[]'](i))})
					.set({visible:true})
					if(i==0) {
						cqlsAEP.tweens.rect[i].call(function(tween) {
							self.hist['$[]'](cur).$draw(self.aep['$[]'](cur)['$[]']("nbTot"));
							self.$allowLevelChange(true);
						})
					}

					cqlsAEP.tweens.pt[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);
					cqlsAEP.tweens.line[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);

					cqlsAEP.tweens.rect[i].wait(before+i)
					.to({y:self.graphHist.$to_Y(self.aep['$[]'](cur)['$[]']("yRect")['$[]'](i))+self.hY['$[]'](cur)/2.0},fall-i)
					.wait(after);
					if(self.icGood['$[]'](i)['$=='](0)) {
						cqlsAEP.tweens.pt[i].to({scaleX:1.0,scaleY:1.0})
						cqlsAEP.tweens.line[i].to({scaleY:1.0})
					}

				;}, TMP_76.$$s = self, TMP_76), $a).call($c);
        
				//only once
				cqlsAEP.tweens.pt[0].call(function(tween) {
						self.$hideAll(cur)
        self.hist['$[]'](cur).$add(self.x['$[]'](cur))
        self.hist['$[]'](cur).$incCptIC(self.cptIC)
        self.hist['$[]'](cur).$draw()
        self.$drawSummary(cur);
				})
			;
        return self.time = self.time['$+'](before['$+'](fall)['$+'](after));
      };

      def.$hideAll = function(cur) {
        var $a, self = this;

        if ((($a = self.x['$[]'](cur)) !== nil && (!$a.$$is_boolean || $a == true))) {
          
					for(i=0;i<cqlsAEP.m.nbsSimMax;i++) {
						cqlsAEP.actors.pt[i].visible=false;
						cqlsAEP.actors.line[i].visible=false;
						cqlsAEP.actors.rect[i].visible=false;	
					}
				
          } else {
          return nil
        };
      };

      def.$drawSummary = function(cur) {
        var self = this, state = nil;

        if (cur == null) {
          cur = self.curIndHist
        }
        self.hist['$[]'](cur).$drawMean();
        self.hist['$[]'](cur).$drawSD();
        return state = cqlsAEP.f.getValue("checkSummary");
      };

      def.$updateVisible = function() {
        var self = this, isTransf = nil, isSample = nil, state = nil;

        isTransf = self.$transfMode()['$==']("none")['$!']();
        isSample = self.$transfMode()['$==']("sample");
        
				self.exp['$[]'](0).shape.visible=cqlsAEP.f.getValue("checkExp0Curve");
				self.exp['$[]'](1).shape.visible=isTransf & cqlsAEP.f.getValue("checkExp1Curve");
				self.hist['$[]'](0).shape.visible=isTransf['$!']();
				self.hist['$[]'](1).shape.visible=isTransf;
				self.hist['$[]'](0).curveShape.visible=isTransf['$!']() & cqlsAEP.f.getValue("checkHistCurve");
				self.hist['$[]'](1).curveShape.visible=isTransf & cqlsAEP.f.getValue("checkHistCurve");
				self.hist['$[]'](0).summaryShapes[0].visible=false;
				self.hist['$[]'](1).summaryShapes[0].visible=false;
				self.hist['$[]'](0).summaryShapes[1].visible=false;
				self.hist['$[]'](1).summaryShapes[1].visible=false;
				self.checkTCL.shape.visible=isSample & cqlsAEP.f.getValue("checkTCL");
			;
        self.exp['$[]'](0).expAxisShape.visible= !cqlsAEP.f.getValue("checkExp0Curve");
        self.exp['$[]'](1).expAxisShape.visible= false;
        state = cqlsAEP.f.getValue("checkSummary");
        self.exp['$[]'](0).summaryShapes[0].visible=cqlsAEP.f.getValue("checkExp0Mean");
        self.exp['$[]'](0).summaryShapes[1].visible=cqlsAEP.f.getValue("checkExp0SD");
        self.exp['$[]'](1).summaryShapes[0].visible=isTransf & cqlsAEP.f.getValue("checkExp1Mean");
        self.exp['$[]'](1).summaryShapes[1].visible=isTransf & cqlsAEP.f.getValue("checkExp1SD");
        self.histCur.summaryShapes[0].visible=cqlsAEP.f.getValue("checkHistMean");
        self.histCur.summaryShapes[1].visible=cqlsAEP.f.getValue("checkHistSD");
        self.$updateTCL(cqlsAEP.f.getValue("checkTCL"));
        return cqlsAEP.m.stage.update();
      };

      def.$playShort = function(cur, duration) {
        var $a, $b, $c, TMP_77, self = this, x = nil, q = nil, mu = nil;

        if (cur == null) {
          cur = self.curIndHist
        }
        if (duration == null) {
          duration = 500
        }
        self.$hideAll(cur);
        self.$animMode();
        self.time = 0;
        if ((($a = ($b = self.transf, $b !== false && $b !== nil ?(((($c = self.transf['$[]']("dist")['$==']("exact")['$!']()) !== false && $c !== nil) ? $c : self.statMode['$==']("ic"))) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          x = [];
          if (self.statMode['$==']("ic")) {
            $a = [self.n01.$quantile((1)['$-'](self.alpha['$/'](2))), self.exp['$[]'](0).$distrib().$mean()], q = $a[0], mu = $a[1]};
          ($a = ($b = ($range(0, ((10)['$**'](cqlsAEP.i.count)), true))).$each, $a.$$p = (TMP_77 = function(i){var self = TMP_77.$$s || this, $a, $b, xx = nil, icSide = nil;
            if (self.exp == null) self.exp = nil;
            if (self.n == null) self.n = nil;
            if (self.statMode == null) self.statMode = nil;
            if (self.hist == null) self.hist = nil;
if (i == null) i = nil;
          xx = self.exp['$[]'](0).$sample(self.n);
            x['$[]='](i, self.$applyTransfByValue(xx));
            if (self.statMode['$==']("ic")) {
              icSide = q['$*'](self.$seMean_transf(xx));
              if ((($a = ($b = (x['$[]'](i)['$-'](icSide)['$<='](mu)), $b !== false && $b !== nil ?(mu['$<='](x['$[]'](i)['$+'](icSide))) : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
                return ($a = self.hist['$[]'](cur), $a['$cptICTot=']($a.$cptICTot()['$+'](1)))
                } else {
                return nil
              };
              } else {
              return nil
            };}, TMP_77.$$s = self, TMP_77), $a).call($b);
          self.hist['$[]'](cur).$add(x);
          } else {
          self.hist['$[]'](cur).$add(self.exp['$[]'](cur).$sample((10)['$**'](cqlsAEP.i.count)))
        };
        self.hist['$[]'](cur).$draw();
        self.$drawSummary(cur);
        cqlsAEP.m.stage.update();
        return self.$playNextAfter(duration);
      };

      def.$playLongDensityBasic = function(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000
        }
        self.$addXY(self.nbSim);
        self.$transitionInitHist(0);
        self.$transitionInitPts(0);
        self.$transitionInitRects(0);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionFallPts(0);
        self.$transitionHistPtsAndRects(0);
        return self.$playNextAfter(self.time['$+'](duration));
      };

      def.$playLongDensityBasicHidden = function(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000
        }
        self.$addXY(self.nbSim);
        self.$transitionInitHist(0, "new");
        self.$transitionInitPts(0);
        self.$transitionInitExpRects(0);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionExpPtsAndRects(0);
        self.$transitionInitHist(0, "reduced");
        self.$transitionDrawRectsHidden(0);
        self.$transitionInitHist(0);
        self.$transitionHistPtsAndRectsHidden(0);
        return self.$playNextAfter(self.time['$+'](duration));
      };

      def.$playLongDensityWithTransf = function(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1);
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionFallPts(1);
        self.$transitionHistPtsAndRects(1);
        return self.$playNextAfter(self.time['$+'](duration));
      };

      def.$playLongDensityWithTransfHidden = function(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1, "new");
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitExpRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionExpPtsAndRects(1);
        self.$transitionInitHist(1, "reduced");
        self.$transitionDrawRectsHidden(1);
        self.$transitionInitHist(1);
        self.$transitionHistPtsAndRectsHidden(1);
        return self.$playNextAfter(self.time['$+'](duration));
      };

      def.$playLongDensityForIC = function(duration) {
        var self = this;

        if (duration == null) {
          duration = 1000
        }
        self.$addXY(self.nbSim);
        self.$transitionInitTransf(0, 1);
        self.$transitionInitHist(0);
        self.$transitionInitHist(1);
        self.$transitionInitPts(0);
        self.$transitionInitPtsTransf(0);
        self.$transitionInitRects(1);
        self.$transitionInitTime();
        self.$transitionDrawPts(0);
        self.$transitionPtsTransf(1);
        self.$transitionInitPtsTransf(1);
        self.$transitionDrawPts(1);
        self.$transitionDrawIC();
        return self.$playNextAfter(self.time['$+'](duration));
      };

      def['$isModeHidden?'] = function() {
        var self = this;

        self.$animMode();
        self.modeHidden = !cqlsAEP.i.prior;
        if (self.statMode['$==']("ic")) {
          self.modeHidden = false};
        return self.modeHidden;
      };

      def.$playLongDensity = function(duration) {
        var $a, self = this;

        if (duration == null) {
          duration = 1000
        }
        if ((($a = self.transf) !== nil && (!$a.$$is_boolean || $a == true))) {
          if ((($a = self['$isModeHidden?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
            return self.$playLongDensityWithTransfHidden(duration)
          } else if (self.statMode['$==']("ic")) {
            return self.$playLongDensityForIC(duration)
            } else {
            return self.$playLongDensityWithTransf(duration)
          }
        } else if ((($a = self['$isModeHidden?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.$playLongDensityBasicHidden(duration)
          } else {
          return self.$playLongDensityBasic(duration)
        };
      };

      return (def.$playNextAfter = function(duration) {
        var self = this;

        
				createjs.Tween.get(cqlsAEP.m.stage,{override:true}).wait(duration).call(
					function(tween) {
						if(cqlsAEP.i.loop) cqlsAEP.f.updateDemo();
					}
				);
			;
      }, nil) && 'playNextAfter';
    })(self, null);

    (function($base, $super) {
      function $Distribution(){};
      var self = $Distribution = $klass($base, $super, 'Distribution', $Distribution);

      var def = self.$$proto, $scope = self.$$scope;

      def.list = def.name = def.params = def.originalDistrib = def.type = def.distrib = nil;
      self.$attr_accessor("list", "name", "params", "distrib");

      def.$initialize = function(name, params, transf) {
        var $a, $b, self = this;

        if (name == null) {
          name = nil
        }
        if (params == null) {
          params = []
        }
        if (transf == null) {
          transf = nil
        }
        if ((($a = (($b = Opal.cvars['@@list']) == null ? nil : $b)) !== nil && (!$a.$$is_boolean || $a == true))) {
          } else {
          (Opal.cvars['@@list'] = $hash2(["uniform", "normal", "t", "chi2", "exp", "cauchy", "discreteUniform", "bernoulli", "binomial", "birthday", "mean", "sum", "locationScale", "square", "sumOfSq"], {"uniform": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["UniformDistribution"], "qbounds": [0, 1]}), "normal": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["NormalDistribution"], "qbounds": [cqlsAEP.m.qmin, cqlsAEP.m.qmax]}), "t": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["StudentDistribution"], "qbounds": [cqlsAEP.m.qmin, cqlsAEP.m.qmax]}), "chi2": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ChiSquareDistribution"], "qbounds": [0, cqlsAEP.m.qmax]}), "exp": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["ExponentialDistribution"], "qbounds": [0, cqlsAEP.m.qmax]}), "cauchy": $hash2(["type", "dist", "qbounds"], {"type": "cont", "dist": ["CauchyDistribution"], "qbounds": [0.01, 0.99]}), "discreteUniform": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["DiscreteUniformDistribution"], "qbounds": [0, 1]}), "bernoulli": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BernoulliDistribution"], "qbounds": [0, 1]}), "binomial": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BinomialDistribution"], "qbounds": [0, 1]}), "birthday": $hash2(["type", "dist", "qbounds"], {"type": "disc", "dist": ["BirthdayDistribution"], "qbounds": [0.01, 1]}), "mean": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sum": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "locationScale": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "square": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]}), "sumOfSq": $hash2(["dist", "qbounds"], {"dist": "none", "qbounds": [0, 1]})}))
        };
        self.list = (($a = Opal.cvars['@@list']) == null ? nil : $a);
        if (name !== false && name !== nil) {
          if (transf !== false && transf !== nil) {
            return self.$setAsTransfOf($scope.get('Distribution').$new(name, params), transf)
            } else {
            return self.$set(name, params)
          }
          } else {
          return nil
        };
      };

      def.$set = function(dist, params) {
        var $a, self = this, instr = nil;

        $a = [dist, params], self.name = $a[0], self.params = $a[1];
        self.type = self.list['$[]'](self.name)['$[]']("type");
        instr = "new "['$+'](self.list['$[]'](self.name)['$[]']("dist").$join("."))['$+']("(")['$+'](self.params.$join(","))['$+'](");");
        return self.distrib = eval(instr);
      };

      def.$setAsTransfOf = function(dist, transf) {
        var $a, $b, TMP_78, self = this, $case = nil, d = nil;

        $a = [transf['$[]']("name"), transf['$[]']("args")], self.name = $a[0], self.params = $a[1];
        self.originalDistrib = dist;
        return (function() {$case = self.name;if ("square"['$===']($case)) {return self.distrib = new PowerDistribution(self.originalDistrib.distrib,2)}else if ("mean"['$===']($case)) {d = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0));
        return self.distrib = new LocationScaleDistribution(d,0,1/self.params['$[]'](0));}else if ("sum"['$===']($case)) {return self.distrib = new Convolution(self.originalDistrib.distrib,self.params['$[]'](0))}else if ("locationScale"['$===']($case)) {return self.distrib = new LocationScaleDistribution(self.originalDistrib.distrib,self.params['$[]'](0),self.params['$[]'](1))}else if ("sumOfSq"['$===']($case)) {d = new LocationScaleDistribution(self.originalDistrib.distrib,-self.originalDistrib.$mean()/self.originalDistrib.$stdDev(),1/self.originalDistrib.$stdDev());
        d = new PowerDistribution(d,2);
        if ((($a = d.type === CONT) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.distrib = new Convolution(d,self.params['$[]'](0))
          } else {
          self.distrib = $scope.get('Convolution').$power(d, self.params['$[]'](0));
          return self.$p(["boundsDistrib", self.$step(), self.$bounds(), self.$pdf(self.$bounds()), ($a = ($b = self.$pdf(self.$bounds())).$inject, $a.$$p = (TMP_78 = function(e, e2){var self = TMP_78.$$s || this;
if (e == null) e = nil;if (e2 == null) e2 = nil;
          return e = e['$+'](e2)}, TMP_78.$$s = self, TMP_78), $a).call($b, 0)]);
        };}else { return nil }})();
      };

      def.$type = function() {
        var $a, self = this;

        return ((($a = self.type) !== false && $a !== nil) ? $a : self.originalDistrib.$type());
      };

      def.$qbounds = function() {
        var self = this;

        return self.list['$[]'](self.name)['$[]']("qbounds");
      };

      def.$bounds = function() {
        var $a, $b, TMP_79, $c, $d, TMP_80, TMP_81, self = this, qb = nil, $case = nil, a = nil, b = nil, s = nil;

        qb = (function() {if ((($a = self.originalDistrib) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.originalDistrib.$qbounds()
          } else {
          return self.$qbounds()
        }; return nil; })();
        return (function() {$case = self.$type();if ("cont"['$===']($case)) {return ($a = ($b = qb).$map, $a.$$p = (TMP_79 = function(e){var self = TMP_79.$$s || this;
if (e == null) e = nil;
        return self.$quantile(e)}, TMP_79.$$s = self, TMP_79), $a).call($b)}else if ("disc"['$===']($case)) {if ((($a = self['$regular?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          $a = Opal.to_ary(($c = ($d = qb).$map, $c.$$p = (TMP_80 = function(e){var self = TMP_80.$$s || this;
if (e == null) e = nil;
          return self.$quantile(e)}, TMP_80.$$s = self, TMP_80), $c).call($d)), a = ($a[0] == null ? nil : $a[0]), b = ($a[1] == null ? nil : $a[1]);
          s = self.$step();
          return ($a = ($c = $scope.get('Range').$new(0, ((b['$-'](a))['$/'](s))).$to_a()).$map, $a.$$p = (TMP_81 = function(e){var self = TMP_81.$$s || this;
if (e == null) e = nil;
          return a['$+'](e['$*'](s))}, TMP_81.$$s = self, TMP_81), $a).call($c);
          } else {
          return self.distrib.values();
        }}else { return nil }})();
      };

      def.$minValue = function() {
        var self = this;

        return self.distrib.minValue();
      };

      def.$maxValue = function() {
        var self = this;

        return self.distrib.maxValue();
      };

      def['$regular?'] = function() {
        var self = this;

        return self.distrib.regular();
      };

      def.$step = function() {
        var $a, $b, TMP_82, self = this, b = nil;

        if ((($a = self['$regular?']()) !== nil && (!$a.$$is_boolean || $a == true))) {
          return self.distrib.step();
          } else {
          b = self.$bounds();
          return ($a = ($b = ($range(1, b.$length(), true))).$map, $a.$$p = (TMP_82 = function(i){var self = TMP_82.$$s || this;
if (i == null) i = nil;
          return (b['$[]'](i)['$-'](b['$[]'](i['$-'](1)))).$abs()}, TMP_82.$$s = self, TMP_82), $a).call($b).$min().$to_f();
        };
      };

      def.$mean = function() {
        var self = this;

        return self.distrib.mean();
      };

      def.$mode = function() {
        var self = this;

        return self.distrib.mode();
      };

      def.$maxPdf = function() {
        var self = this;

        return self.distrib.maxDensity();
      };

      def.$variance = function() {
        var self = this;

        return self.distrib.variance();
      };

      def.$stdDev = function() {
        var self = this;

        return self.distrib.stdDev();
      };

      def.$sample = function(n) {
        var self = this;

        if (n == null) {
          n = 1
        }
        z=[];for(i=0;i<n;i++) z[i]=self.distrib.simulate();return z
      };

      def.$pdf = function(x) {
        var self = this;

        return x.map(function(e) {return self.distrib.density(e);});
      };

      return (def.$quantile = function(alpha) {
        var self = this;

        return self.distrib.quantile(alpha);
      }, nil) && 'quantile';
    })(self, null);

    (function($base, $super) {
      function $Convolution(){};
      var self = $Convolution = $klass($base, $super, 'Convolution', $Convolution);

      var def = self.$$proto, $scope = self.$$scope;

      def.b1 = def.bounds = nil;
      Opal.defs($scope.get('Convolution'), '$power', function(d, n) {
        var $a, $b, TMP_83, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        if ((($a = d instanceof Distribution) !== nil && (!$a.$$is_boolean || $a == true))) {
          $a = [d, d.values()], dist = $a[0], b = $a[1];
          $a = [d, d.values()], dist2 = $a[0], b2 = $a[1];
          } else {
          $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1];
          $a = [d.$distrib(), d.$bounds()], dist2 = $a[0], b2 = $a[1];
        };
        ($a = ($b = ($range(1, n, true))).$each, $a.$$p = (TMP_83 = function(i){var self = TMP_83.$$s || this;
if (i == null) i = nil;
        dist2 = new Convolution2(dist,dist2,b,b2);
          return b2 = dist2.values();}, TMP_83.$$s = self, TMP_83), $a).call($b);
        return dist2;
      });

      Opal.defs($scope.get('Convolution'), '$two', function(d, d2) {
        var $a, self = this, dist = nil, b = nil, dist2 = nil, b2 = nil;

        $a = [d.$distrib(), d.$bounds()], dist = $a[0], b = $a[1];
        $a = [d2.$distrib(), d2.$bounds()], dist2 = $a[0], b2 = $a[1];
        return new Convolution2(dist,dist2,b,b2);
      });

      def.$initialize = function(d1, d2, b1, b2) {
        var $a, self = this;

        $a = [d1, d2, b1, b2], self.d1 = $a[0], self.d2 = $a[1], self.b1 = $a[2], self.b2 = $a[3];
        return self.$prepare();
      };

      return (def.$prepare = function() {
        var $a, $b, TMP_84, $c, TMP_86, self = this, ind = nil;

        ind = $hash2([], {});
        ($a = ($b = self.b1).$each_with_index, $a.$$p = (TMP_84 = function(v1, i1){var self = TMP_84.$$s || this, $a, $b, TMP_85;
          if (self.b2 == null) self.b2 = nil;
if (v1 == null) v1 = nil;if (i1 == null) i1 = nil;
        return ($a = ($b = self.b2).$each_with_index, $a.$$p = (TMP_85 = function(v2, i2){var self = TMP_85.$$s || this, $a, v = nil;
if (v2 == null) v2 = nil;if (i2 == null) i2 = nil;
          v = $scope.get('CqlsAEP').$quantize(v1['$+'](v2));
            if ((($a = ind.$keys()['$include?'](v)) !== nil && (!$a.$$is_boolean || $a == true))) {
              return ind['$[]'](v)['$<<']([i1, i2])
              } else {
              return ind['$[]='](v, [[i1, i2]])
            };}, TMP_85.$$s = self, TMP_85), $a).call($b)}, TMP_84.$$s = self, TMP_84), $a).call($b);
        self.bounds = ind.$keys().$sort();
        self.pdf = [];
        return ($a = ($c = self.bounds).$each_with_index, $a.$$p = (TMP_86 = function(v, i){var self = TMP_86.$$s || this, $a, $b, TMP_87;
          if (self.pdf == null) self.pdf = nil;
if (v == null) v = nil;if (i == null) i = nil;
        self.pdf['$[]='](i, 0);
          return ($a = ($b = ind['$[]'](v)).$each, $a.$$p = (TMP_87 = function(j1, j2){var self = TMP_87.$$s || this, $a, $b;
            if (self.pdf == null) self.pdf = nil;
            if (self.d1 == null) self.d1 = nil;
            if (self.b1 == null) self.b1 = nil;
            if (self.d2 == null) self.d2 = nil;
            if (self.b2 == null) self.b2 = nil;
if (j1 == null) j1 = nil;if (j2 == null) j2 = nil;
          return ($a = i, $b = self.pdf, $b['$[]=']($a, $b['$[]']($a)['$+'](self.d1.density(self.b1['$[]'](j1))* self.d2.density(self.b2['$[]'](j2)))))}, TMP_87.$$s = self, TMP_87), $a).call($b);}, TMP_86.$$s = self, TMP_86), $a).call($c);
      }, nil) && 'prepare';
    })(self, null);

    Opal.cdecl($scope, 'PREC4DISC', 0);

    Opal.defs($scope.get('CqlsAEP'), '$quantize', function(x, prec) {
      var self = this;

      if (prec == null) {
        prec = $scope.get('PREC4DISC')
      }
      return parseFloat(x.toFixed(prec));
    });

    Opal.defs($scope.get('CqlsAEP'), '$equal', function(a, b) {
      var self = this;

      return a.toFixed($scope.get('PREC4DISC'))===b.toFixed($scope.get('PREC4DISC'));
    });

    Opal.defs($scope.get('CqlsAEP'), '$range', function(low, high, step) {
      var self = this;

      
			// From: http://phpjs.org/functions
			// +   original by: Waldo Malqui Silva
			// *     example 1: range ( 0, 12 );
			// *     returns 1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
			// *     example 2: range( 0, 100, 10 );
			// *     returns 2: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
			// *     example 3: range( 'a', 'i' );
			// *     returns 3: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
			// *     example 4: range( 'c', 'a' );
			// *     returns 4: ['c', 'b', 'a']
			var matrix = [];
			var inival, endval, plus;
			var walker = step || 1;
			var chars = false;

			if (!isNaN(low) && !isNaN(high)) {
			inival = low;
			endval = high;
			} else if (isNaN(low) && isNaN(high)) {
			chars = true;
			inival = low.charCodeAt(0);
			endval = high.charCodeAt(0);
			} else {
			inival = (isNaN(low) ? 0 : low);
			endval = (isNaN(high) ? 0 : high);
			}

			plus = ((inival > endval) ? false : true);
			if (plus) {
			while (inival <= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival += walker;
			}
			} else {
			while (inival >= endval) {
			  matrix.push(((chars) ? String.fromCharCode(inival) : inival));
			  inival -= walker;
			}
			}

			return matrix;
		
    });

    Opal.defs($scope.get('CqlsAEP'), '$seq', function(min, max, length) {
      var self = this;

      
			var arr = [],
			hival = Math.pow(10, 17 - ~~(Math.log(((max > 0) ? max : -max)) * Math.LOG10E)),
			step = (max * hival - min * hival) / ((length - 1) * hival),
			current = min,
			cnt = 0;
			// current is assigned using a technique to compensate for IEEE error
			for (; current <= max; cnt++, current = (min * hival + step * hival * cnt) / hival)
				arr.push(current);
			return arr;
		
    });
  })(self)
})(Opal);

/* Generated by Opal 0.7.1 */
(function(Opal) {
  Opal.dynamic_require_severity = "error";
  var self = Opal.top, $scope = Opal, nil = Opal.nil, $breaker = Opal.breaker, $slice = Opal.slice;

  Opal.add_stubs(['$exit']);
  return $scope.get('Kernel').$exit()
})(Opal);
